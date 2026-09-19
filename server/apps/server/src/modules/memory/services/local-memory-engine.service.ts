import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq, inArray, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  memories,
  memoryAccesses,
  memoryTags,
  profiles,
  projects,
  tags,
} from "../../../db/schema";
import type {
  MemoryRecord,
  MemorySearchMeta,
  MemorySearchRequest,
  MemoryWithSimilarityRecord,
  RecallMeta,
} from "../contracts/memory.contract";
import type { MemoryEngine, MemorySearchScopeOptions } from "./memory-engine";
import { decayFieldsFromRecord } from "./memory-decay";
import { embed, toPgVector } from "../repositories/embedding-bge";
import { grantedSessionIdsSql, readableProjectIdsSql } from "../../access/readable-sql";

// The memory engine: plain Postgres. Hybrid search is pgvector cosine
// similarity fused with tsvector keyword rank (reciprocal-rank fusion),
// with access enforced inside the SQL and an optional rerank hop.
@Injectable()
export class LocalMemoryEngine implements MemoryEngine {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
  ) {}

  // The memory row written by MemoryRepository IS the index (its
  // embedding + content_tsv columns), so there is nothing extra to
  // write or remove here. The hooks stay on the interface for engines
  // that keep a separate index.
  async remember(_context: ActorContext, _memory: MemoryRecord): Promise<void> {}

  async forget(_context: ActorContext, _memoryId: string, _hard: boolean): Promise<void> {}

  async search(
    context: ActorContext,
    request: MemorySearchRequest,
    workspaceIds: string[],
    grantedSessionIds: string[] = [],
    options: MemorySearchScopeOptions = {},
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta }> {
    const startedAt = Date.now();

    const projectIds = request.filters.project_ids ?? [];
    const everyReadable = options.everyReadableSpace === true;
    if (projectIds.length === 0 && !everyReadable) {
      throw new ValidationDomainError("memory search requires filters.project_ids");
    }

    // Read path: Postgres only — our own pgvector + tsv indexes, so
    // recall never depends on a downstream service being up (embedding
    // failure degrades to keyword-only below).
    const scopeIds = [...new Set([...projectIds, ...workspaceIds])];
    const primaryProjectIds = new Set(projectIds);
    const includeArchived = request.filters.include_archived;
    const includeSuperseded = request.filters.include_superseded;
    const minConfidence = request.filters.min_confidence ?? 0;
    const kindFilter = request.filters.kinds && request.filters.kinds.length > 0
      ? request.filters.kinds
      : null;
    const limit = Math.max(1, Math.min(request.limit ?? 25, 100));
    const userId = context.principal.userId ?? null;

    // Try to embed the query for vector similarity. If embedding fails
    // (OpenAI down, etc.), degrade to keyword-only — recall still returns.
    const queryText = (request.query ?? "").trim();
    let queryVector: number[] | null = null;
    let embeddingDegraded = false;
    let embedderModel = "unavailable";
    if (queryText && request.mode !== "keyword") {
      try {
        queryVector = await embed(queryText);
        if (queryVector) {
          embedderModel =
            (this.configService.get<string>("OPENKT_EMBEDDING_BACKEND") ?? "bge") === "openai"
              ? this.configService.get<string>("OPENKT_OPENAI_EMBED_MODEL") ?? "text-embedding-3-small"
              : this.configService.get<string>("OPENKT_BGE_MODEL") ?? "bge-m3";
        }
      } catch {
        embeddingDegraded = true;
      }
      if (!queryVector) embeddingDegraded = true;
    }

    const vectorWeight = Math.max(0, Math.min(1, request.vector_weight ?? 0.7));
    const vectorLiteral = queryVector ? toPgVector(queryVector) : null;

    // Each id is bound as its own parameter and explicitly cast — `ANY($arr::uuid[])`
    // with a JS array gets serialized as JSON by pg, which Postgres won't cast.
    // With no space given (everyReadable), the scope is "every space the asker
    // can read, and every session granted to them" — subqueries, not a list.
    const projectScope = everyReadable
      ? userId
        ? sql`(m.project_id IN ${readableProjectIdsSql(userId)} OR m.session_id IN ${grantedSessionIdsSql(userId)})`
        : sql`false`
      : sql`m.project_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
    const kindList = kindFilter
      ? sql.join(kindFilter.map((k) => sql`${k}`), sql`, `)
      : null;
    const sessionIdList = everyReadable && userId
      ? grantedSessionIdsSql(userId)
      : grantedSessionIds.length
        ? sql`(${sql.join(grantedSessionIds.map((id) => sql`${id}::uuid`), sql`, `)})`
        : null;
    // Session-only access (MemorySearchScopeOptions): an empty list means
    // "no session", so it matches nothing rather than everything.
    const onlySessionIds = options.onlySessionIds;
    const onlySessionFilter = onlySessionIds
      ? onlySessionIds.length
        ? sql`AND m.session_id IN (${sql.join(onlySessionIds.map((id) => sql`${id}::uuid`), sql`, `)})`
        : sql`AND false`
      : sql``;

    // Access enforced INSIDE the SQL, before ranking (architecture.md
    // §2 "Read path"). `visibility = 'personal'` memories are excluded
    // for everyone except their owner UNLESS the asker holds a direct
    // grant on the exact session they were saved in — the one case a
    // personal-space memory becomes visible to someone else without
    // promoting the whole project.
    const visibilityGuard = sql`(
      m.visibility <> 'personal'
      ${userId ? sql`OR m.owner_user_id = ${userId}::uuid` : sql``}
      ${sessionIdList ? sql`OR m.session_id IN ${sessionIdList}` : sql``}
    )`;
    const scopeFilter = sql`
      ${projectScope}
      ${includeArchived ? sql`` : sql`AND m.archived = false`}
      ${includeSuperseded ? sql`` : sql`AND m.superseded_by IS NULL`}
      ${kindList ? sql`AND m.kind IN (${kindList})` : sql``}
      ${minConfidence > 0 ? sql`AND m.confidence >= ${minConfidence}` : sql``}
      ${onlySessionFilter}
      AND ${visibilityGuard}
    `;

    // Mild recency prior (M5): up to +15% for content created "now",
    // decaying to +0% over ~30 days. Multiplicative so it nudges the
    // fused rank without letting a brand-new, barely-relevant memory
    // beat a strongly relevant old one.
    const recencyFactor = sql`(1 + 0.15 * exp(-extract(epoch from (now() - m.created_at)) / (30 * 86400.0)))`;

    let rows: { rows: unknown[] };
    let fusion: "rrf" | "keyword_only" | "browse";

    if (!queryText) {
      // Browse mode — no query text, no ranking signal to fuse. Order
      // by importance then recency, same shape recall always returns.
      fusion = "browse";
      rows = await this.db.execute(sql`
        SELECT m.id::text AS id, 0::float AS rrf_score, NULL::float AS vector_similarity
        FROM memories m
        WHERE ${scopeFilter}
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT ${limit}
      `);
    } else if (vectorLiteral) {
      // Hybrid — reciprocal-rank fusion (k=60) of the vector top-50 and
      // the keyword (ts_rank) top-50, both computed over the SAME
      // access-scoped candidate set, then a recency nudge on the fused
      // score. This replaces the old weighted-linear-sum blend.
      const RRF_K = 60;
      const CANDIDATE_N = 50;
      fusion = "rrf";
      rows = await this.db.execute(sql`
        WITH scoped AS (
          SELECT * FROM memories m WHERE ${scopeFilter}
        ),
        vector_ranked AS (
          SELECT id, row_number() OVER (ORDER BY embedding <=> ${vectorLiteral}::vector ASC) AS rnk
          FROM scoped
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${vectorLiteral}::vector ASC
          LIMIT ${CANDIDATE_N}
        ),
        keyword_ranked AS (
          SELECT id, row_number() OVER (
            ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ${queryText})) DESC
          ) AS rnk
          FROM scoped
          WHERE plainto_tsquery('english', ${queryText}) @@ content_tsv
          ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ${queryText})) DESC
          LIMIT ${CANDIDATE_N}
        ),
        fused AS (
          SELECT id, sum(1.0 / (${RRF_K} + rnk)) AS rrf_score
          FROM (
            SELECT * FROM vector_ranked
            UNION ALL
            SELECT * FROM keyword_ranked
          ) u
          GROUP BY id
        )
        SELECT
          f.id::text AS id,
          f.rrf_score::float AS rrf_score,
          (1 - (m.embedding <=> ${vectorLiteral}::vector))::float AS vector_similarity
        FROM fused f
        JOIN memories m ON m.id = f.id
        ORDER BY f.rrf_score * ${recencyFactor} DESC
        LIMIT ${limit}
      `);
    } else {
      // Degraded — keyword-only (embedding unavailable, or mode=keyword).
      //
      // The ORDER BY repeats the ts_rank expression rather than
      // referencing the `rrf_score` output alias: Postgres only
      // resolves an ORDER BY item as an output-column alias when the
      // item is a bare name, not when it's wrapped in another
      // expression (`rrf_score * recency`) — wrapped, it tries to
      // resolve `rrf_score` as an input column on `memories` and
      // fails with "column rrf_score does not exist".
      fusion = "keyword_only";
      rows = await this.db.execute(sql`
        SELECT
          m.id::text AS id,
          COALESCE(ts_rank(m.content_tsv, plainto_tsquery('english', ${queryText})), 0)::float AS rrf_score,
          NULL::float AS vector_similarity
        FROM memories m
        WHERE ${scopeFilter}
          AND plainto_tsquery('english', ${queryText}) @@ m.content_tsv
        ORDER BY (COALESCE(ts_rank(m.content_tsv, plainto_tsquery('english', ${queryText})), 0) * ${recencyFactor}) DESC NULLS LAST
        LIMIT ${limit}
      `);
    }

    const scoreById = new Map<string, { score: number; sim: number | null }>();
    for (const r of rows.rows as Array<{ id: string; rrf_score: string | number; vector_similarity: string | number | null }>) {
      scoreById.set(r.id, {
        score: Number(r.rrf_score) || 0,
        sim: r.vector_similarity === null ? null : Number(r.vector_similarity),
      });
    }

    const records = await this.fetchMemories([...scoreById.keys()]);
    let data = records.map((record) => {
      const hit = scoreById.get(record.id);
      const similarity = this.normalizeScore(hit?.sim ?? hit?.score ?? null);
      return {
        ...record,
        similarity,
        source_scope: everyReadable || primaryProjectIds.has(record.project_id) ? "primary" : "workspace",
        effective_importance: this.effectiveImportance(record.importance, similarity),
      } satisfies MemoryWithSimilarityRecord;
    });

    // Preserve the SQL-side rank order (records map returns in caller-input order).
    data = data.sort((a, b) => {
      const sa = scoreById.get(a.id)?.score ?? 0;
      const sb = scoreById.get(b.id)?.score ?? 0;
      return sb - sa;
    });

    // Optional cross-encoder rerank over the fused top results — an
    // HTTP call to any OpenAI/TEI-compatible `/rerank` endpoint
    // (OPENKT_RERANK_URL). Skipped cleanly (no network call at all)
    // when unset, and fails open (keeps the fused order) on any error
    // or timeout — a rerank sidecar hiccup must never break recall.
    const rerankUrl = this.configService.get<string>("OPENKT_RERANK_URL");
    let reranked = false;
    if (rerankUrl && queryText && data.length > 1) {
      const rerankedData = await this.rerank(rerankUrl, queryText, data);
      if (rerankedData) {
        data = rerankedData;
        reranked = true;
      }
    }

    const ranked = data.slice(0, limit);

    return {
      data: ranked,
      meta: {
        total_matched: ranked.length,
        mode: request.mode,
        vector_weight: vectorLiteral ? vectorWeight : null,
        embedding_model: embedderModel,
        next_cursor: null,
        query_ms: Date.now() - startedAt,
        workspace_weight: request.workspace_weight,
        workspace_size: workspaceIds.length,
        // Surface degradation so the FE can show a banner if it cares.
        degraded: embeddingDegraded || undefined,
        degraded_reason: embeddingDegraded ? "embedding_unavailable_keyword_only" : undefined,
        fusion,
        reranked,
      } as MemorySearchMeta,
    };
  }

  // Cross-encoder rerank over the fused candidates. Contract is the
  // common TEI/Cohere-style shape: POST { query, documents } → either
  // `[{ index, score }]` or `{ results: [{ index, relevance_score }] }`
  // (both accepted since "OpenAI/TEI-compatible" covers either). On
  // any failure, returns null so the caller keeps the fused order.
  private async rerank(
    url: string,
    query: string,
    candidates: MemoryWithSimilarityRecord[],
  ): Promise<MemoryWithSimilarityRecord[] | null> {
    const timeoutMs = this.configService.get<number>("OPENKT_RERANK_TIMEOUT_MS") ?? 2000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          documents: candidates.map((c) => c.content),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as
        | Array<{ index: number; score?: number; relevance_score?: number }>
        | { results?: Array<{ index: number; score?: number; relevance_score?: number }> };
      const entries = Array.isArray(payload) ? payload : payload.results ?? [];
      if (entries.length === 0) return null;

      const withScore = entries
        .map((entry) => ({
          candidate: candidates[entry.index],
          score: entry.score ?? entry.relevance_score ?? 0,
        }))
        .filter((entry): entry is { candidate: MemoryWithSimilarityRecord; score: number } =>
          Boolean(entry.candidate),
        )
        .sort((a, b) => b.score - a.score);

      if (withScore.length === 0) return null;
      return withScore.map((entry) => entry.candidate);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(
    context: ActorContext,
    searchResult: { data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta },
    invocationId?: string,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }> {
    if (searchResult.data.length > 0) {
      await this.db.insert(memoryAccesses).values(
        searchResult.data.map((memory) => ({
          memoryId: memory.id,
          actorUserId: context.principal.userId ?? null,
          action: "recall",
          surface: "api",
          invocationId: invocationId ?? null,
        })),
      );
    }
    return { data: searchResult.data, meta: { query_ms: searchResult.meta.query_ms } };
  }

  private async fetchMemories(memoryIds: string[]): Promise<MemoryRecord[]> {
    if (memoryIds.length === 0) return [];
    const rows = await this.db
      .select({
        m: memories,
        projectSlug: projects.slug,
        projectName: projects.name,
        projectVisibility: projects.visibility,
        ownerEmail: profiles.email,
        ownerDisplayName: profiles.displayName,
      })
      .from(memories)
      .innerJoin(projects, eq(projects.id, memories.projectId))
      .leftJoin(profiles, eq(profiles.userId, memories.ownerUserId))
      .where(inArray(memories.id, memoryIds));

    const tagMap = await this.hydrateTags(rows.map((row) => row.m.id));
    const byId = new Map(rows.map((row) => [row.m.id, this.toRecord(row, tagMap.get(row.m.id) ?? [])]));
    return memoryIds.map((id) => byId.get(id)).filter((value): value is MemoryRecord => Boolean(value));
  }

  private async hydrateTags(memoryIds: string[]) {
    if (memoryIds.length === 0) return new Map<string, { id: string; slug: string; display_name: string }[]>();
    const rows = await this.db
      .select({
        memoryId: memoryTags.memoryId,
        id: tags.id,
        slug: tags.slug,
        displayName: tags.displayName,
      })
      .from(memoryTags)
      .innerJoin(tags, eq(tags.id, memoryTags.tagId))
      .where(inArray(memoryTags.memoryId, memoryIds));
    const map = new Map<string, { id: string; slug: string; display_name: string }[]>();
    for (const row of rows) {
      const list = map.get(row.memoryId) ?? [];
      list.push({ id: row.id, slug: row.slug, display_name: row.displayName });
      map.set(row.memoryId, list);
    }
    return map;
  }

  private normalizeScore(score: number | null): number | null {
    if (score === null || !Number.isFinite(score)) return null;
    if (score >= 0 && score <= 1) return score;
    return Math.max(0, Math.min(1, score / (score + 1)));
  }

  private effectiveImportance(importance: number, similarity: number | null): number {
    return Math.max(0, Math.min(1, importance * 0.4 + (similarity ?? 0.5) * 0.6));
  }

  private toRecord(
    row: {
      m: typeof memories.$inferSelect;
      projectSlug: string;
      projectName: string;
      projectVisibility: string;
      ownerEmail: string | null;
      ownerDisplayName: string | null;
    },
    rowTags: { id: string; slug: string; display_name: string }[],
  ): MemoryRecord {
    const m = row.m;
    const importance = Number(m.importance);
    const decayLambda = Number(m.decayLambda);
    const importanceAtIso =
      m.importanceAt instanceof Date ? m.importanceAt.toISOString() : String(m.importanceAt);
    const decayFields = decayFieldsFromRecord(importance, decayLambda, importanceAtIso);
    return {
      id: m.id,
      org_id: m.orgId,
      project_id: m.projectId,
      owner: {
        user_id: m.ownerUserId,
        email: row.ownerEmail,
        display_name: row.ownerDisplayName,
      },
      content: m.content,
      kind: m.kind as MemoryRecord["kind"],
      category: m.category,
      tags: rowTags,
      visibility: m.visibility as MemoryRecord["visibility"],
      confidence: Number(m.confidence),
      importance,
      decay_lambda: decayLambda,
      importance_at: importanceAtIso,
      importance_now: decayFields.importance_now,
      decay_state: decayFields.decay_state,
      access_count: m.recallCount ?? 0,
      last_accessed_at: m.lastRecallAt instanceof Date ? m.lastRecallAt.toISOString() : m.lastRecallAt,
      source_refs: Array.isArray(m.sourceRefs) ? m.sourceRefs as MemoryRecord["source_refs"] : [],
      superseded_by: m.supersededBy,
      archived: m.archived,
      created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
      updated_at: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : String(m.updatedAt),
      project: {
        id: m.projectId,
        slug: row.projectSlug,
        name: row.projectName,
        visibility: row.projectVisibility as MemoryRecord["project"]["visibility"],
      },
      session_id: m.sessionId ?? null,
      source: m.source ?? null,
    };
  }
}
