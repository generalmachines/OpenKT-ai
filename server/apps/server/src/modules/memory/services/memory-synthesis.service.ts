import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { memories } from "../../../db/schema";
import type { CreateMemoryInput, MemoryRecord } from "../contracts/memory.contract";
import { embed, toPgVector } from "../repositories/embedding-bge";
import { MemoryRepository } from "../repositories/memory.repository";

/**
 * MemorySynthesisService — runs at write time (inside
 * MemoryCommandsApplicationService.create) to dedupe + merge incoming
 * memories before they pollute the project with near-duplicate rows.
 *
 * Closes server-track bd issue de-synmem.
 *
 * Why this matters: an agent saying "use AWS for hosting" five times
 * across five sessions used to produce five separate memory rows that
 * recall would all return as separate hits. Bad signal-to-noise for
 * downstream readers. Synthesize-on-save folds those into a single
 * canonical row whose importance compounds each time the same fact
 * arrives.
 *
 * Modes (configurable via OPENKT_SYNTHESIS_MODE, default "dedup-only"):
 *   - off          → bypass entirely; existing create flow runs as-is
 *   - dedup-only   → MERGE when cosine ≥ MERGE_THRESHOLD (0.92).
 *                    For 0.75-0.92, fall through to a normal create
 *                    (no LLM cost). This is the v1 ship.
 *   - full-llm     → reserved for v2; will run LLM synthesis on
 *                    clusters in the 0.75-0.92 range and mark
 *                    superseded_by chains. Treated same as
 *                    dedup-only in v1.
 *
 * Cost: dedup-only adds ONE embed call (~50-100ms) + ONE small DB
 * query per save. No LLM tokens spent. Reads from same pgvector +
 * cosine index the recall pipeline uses.
 *
 * Failure mode: if anything fails (embed timeout, DB query error),
 * the service returns null and the caller falls through to the
 * normal create. Synthesis must never block a write; a missed dedup
 * just produces one extra row.
 */

// Tuned for OpenKT's BGE-m3 + OpenAI text-embedding-3-large vectors.
// Both models produce L2-normalized embeddings, so cosine similarity
// of 0.92+ on natural-language statements indicates near-duplicate
// content even when phrasings differ ("we use AWS" ≈ "use AWS for
// hosting"). Threshold sweep / bench will refine via de-rcbnch.
const MERGE_THRESHOLD = 0.92;
// Reserved for the v2 SUPERSEDE path (full-llm mode). Captured here
// so the comments stay in sync between dedup-only and full-llm flows
// when we revisit.
// const SUPERSEDE_THRESHOLD = 0.75;

const TOP_K_NEIGHBORS = 5;

export type SynthesisMode = "off" | "dedup-only" | "full-llm";

export interface SynthesisResult {
  // The existing memory we merged into (when MERGE happened).
  // Callers return this to the client as the "saved" memory.
  merged: MemoryRecord;
  similarity: number;
  reason: string;
}

@Injectable()
export class MemorySynthesisService {
  private readonly logger = new Logger(MemorySynthesisService.name);
  private readonly mode: SynthesisMode;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
    private readonly memoryRepository: MemoryRepository,
  ) {
    const raw = (this.configService.get<string>("OPENKT_SYNTHESIS_MODE") ?? "dedup-only").toLowerCase();
    this.mode = (raw === "off" || raw === "full-llm" || raw === "dedup-only")
      ? (raw as SynthesisMode)
      : "dedup-only";
  }

  /**
   * Try to absorb the incoming memory into an existing one.
   *
   * Returns:
   *   - SynthesisResult when MERGE happened — caller should return
   *     `result.merged` to the client and SKIP its normal create.
   *   - null when no synthesis happened — caller proceeds with the
   *     existing create flow.
   *
   * Never throws — synthesis errors fall through to null so the
   * caller's write path stays sturdy.
   */
  async tryDedup(
    context: ActorContext,
    projectId: string,
    input: CreateMemoryInput,
  ): Promise<SynthesisResult | null> {
    if (this.mode === "off") {
      return null;
    }

    // Embed the new content sync. ~50-100ms typical; bounded by
    // EMBEDDING_TIMEOUT_MS upstream (60s) so a stuck embedder can't
    // hang the save indefinitely.
    let vector: number[] | null;
    try {
      vector = await embed(input.content);
    } catch (err) {
      this.logger.warn(`synthesis: embed failed: ${(err as Error).message}`);
      return null;
    }
    if (!vector) return null;

    // Vector-search top-K nearest non-archived, non-superseded
    // memories in this project. We use cosine distance (the same
    // operator the recall path uses) and threshold on similarity =
    // 1 - distance.
    const vectorLiteral = toPgVector(vector);

    let rows: { id: string; similarity: number }[];
    try {
      const result = await this.db.execute<{ id: string; similarity: number }>(
        sql`
          SELECT
            m.id::text AS id,
            (1 - (m.embedding <=> ${vectorLiteral}::vector))::float AS similarity
          FROM memories m
          WHERE m.project_id = ${projectId}::uuid
            AND m.archived = false
            AND m.superseded_by IS NULL
            AND m.embedding IS NOT NULL
          ORDER BY m.embedding <=> ${vectorLiteral}::vector
          LIMIT ${TOP_K_NEIGHBORS}
        `,
      );
      rows = result.rows as { id: string; similarity: number }[];
    } catch (err) {
      this.logger.warn(`synthesis: neighbor query failed: ${(err as Error).message}`);
      return null;
    }

    if (rows.length === 0) {
      return null;
    }

    const top = rows[0];
    if (top.similarity < MERGE_THRESHOLD) {
      // Below MERGE threshold — even in full-llm mode (v2) we'd only
      // SUPERSEDE in the 0.75-0.92 band, which isn't built yet.
      // Caller proceeds with normal create.
      return null;
    }

    // MERGE path. The existing memory is a near-duplicate; instead
    // of writing a new row, we bump the existing one's importance,
    // append the incoming source_refs, and let the caller return it
    // as the "saved" memory.
    const existing = await this.memoryRepository.findById(context, top.id);
    if (!existing) {
      // Race: neighbor was archived between query and read. Fall
      // through to normal create.
      return null;
    }

    // Bump importance via diminishing-returns (so the 10th dupe doesn't
    // overweight) + append source_refs. confidence_history and
    // rolls_up_memory_count live as DB-only columns (not on
    // MemoryRecord contract) — incremented atomically in SQL so we
    // don't need to read-modify-write through the type system.
    const newImportance = Math.min(
      1,
      existing.importance + (1 - existing.importance) * 0.2,
    );
    const newSourceRefs = mergeSourceRefs(existing.source_refs, input.source_refs ?? []);
    const incomingConfidencePct = Math.round((input.confidence ?? 0.5) * 100);

    try {
      await this.db
        .update(memories)
        .set({
          importance: newImportance,
          importanceAt: new Date(),
          sourceRefs: newSourceRefs,
          // Atomic increment so concurrent merges of the same memory
          // don't race the counter. The column defaults to 1 on
          // insert; this brings it to N+1 for every absorbed dupe.
          rollsUpMemoryCount: sql`${memories.rollsUpMemoryCount} + 1`,
          // Append the new confidence sample to confidence_history,
          // capping at 20 entries via slice in pgsql (newest last).
          confidenceHistory: sql`(
            (COALESCE(${memories.confidenceHistory}, '{}'::integer[]) || ${incomingConfidencePct}::integer)
            [GREATEST(array_length(COALESCE(${memories.confidenceHistory}, '{}'::integer[]), 1) + 1 - 20, 1):]
          )`,
          updatedAt: new Date(),
        })
        .where(and(eq(memories.id, existing.id), eq(memories.archived, false)));
    } catch (err) {
      this.logger.warn(`synthesis: merge update failed: ${(err as Error).message}`);
      return null;
    }

    const reloaded = await this.memoryRepository.findById(context, existing.id);
    return {
      merged: reloaded ?? existing,
      similarity: top.similarity,
      reason: `merged into existing memory (cosine ${top.similarity.toFixed(3)} ≥ ${MERGE_THRESHOLD})`,
    };
  }

  /**
   * Public hook for the future SUPERSEDE / cluster-rewrite path
   * (full-llm mode). Today this is a no-op; v2 will fill it in.
   * Exposed so callers can wire the dispatch site once and not
   * touch it again.
   */
  async trySupersedeCluster(
    _context: ActorContext,
    _projectId: string,
    _input: CreateMemoryInput,
  ): Promise<SynthesisResult | null> {
    return null;
  }
}

/**
 * mergeSourceRefs — union the two source-ref arrays without
 * duplicates. Order is preserved (existing refs first, new ones
 * appended), bounded to 50 entries.
 */
function mergeSourceRefs(existing: unknown, incoming: unknown[]): unknown[] {
  const existingArr = Array.isArray(existing) ? existing : [];
  const incomingArr = Array.isArray(incoming) ? incoming : [];
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const ref of [...existingArr, ...incomingArr]) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= 50) break;
  }
  return out;
}
