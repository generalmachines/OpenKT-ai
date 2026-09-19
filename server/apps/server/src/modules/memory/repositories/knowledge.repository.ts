import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { NotFoundDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { episodeMemories, episodes } from "../../../db/schema";
import type { KnowledgeNode } from "../contracts/memory.contract";

// Read-side projection for the knowledge-synthesis layer
// (migration 0014). Episodes carry an LLM-synthesised summary +
// tag-set + confidence; this repository hydrates them into the
// `KnowledgeNode` contract surfaced through
// `POST /v1/memories/recall` (when `include_knowledge=true`) and
// `GET /v1/episodes/:id`.
//
// Archived episodes are filtered out at the SQL layer — they exist
// only as audit trail and never surface through the read API.
@Injectable()
export class KnowledgeRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Return the latest unarchived knowledge node for a project whose
   * tag-set overlaps any of the supplied tag slugs. Caller is
   * expected to enforce project-access auth before calling.
   */
  async listForProjectByTags(
    projectId: string,
    tagSlugs: string[],
    limit: number,
  ): Promise<KnowledgeNode[]> {
    if (tagSlugs.length === 0) return [];

    const rows = await this.db
      .select({
        id: episodes.id,
        summary: episodes.summary,
        tags: episodes.tags,
        confidence: episodes.confidence,
        createdAt: episodes.createdAt,
        updatedAt: episodes.updatedAt,
      })
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
          isNull(episodes.archivedAt),
          // `tags && $::text[]` — array overlap. Drizzle doesn't have
          // a typed helper for the && operator, so we drop into raw
          // SQL for the predicate. Each slug is bound individually
          // inside ARRAY[...] — interpolating the JS array directly
          // expands to `($1, $2, ...)`, a record Postgres can't cast
          // to text[] (same bug class as os-sts1).
          sql`${episodes.tags} && array[${sql.join(
            tagSlugs.map((slug) => sql`${slug}`),
            sql`, `,
          )}]::text[]`,
        ),
      )
      .orderBy(desc(episodes.updatedAt))
      .limit(limit);

    if (rows.length === 0) return [];
    return this.hydrate(rows);
  }

  /**
   * Fetch a single knowledge node by id. Throws NotFoundDomainError if
   * the row is missing or archived — archived nodes are audit-only.
   */
  async getById(id: string): Promise<KnowledgeNode> {
    const rows = await this.db
      .select({
        id: episodes.id,
        summary: episodes.summary,
        tags: episodes.tags,
        confidence: episodes.confidence,
        archivedAt: episodes.archivedAt,
        createdAt: episodes.createdAt,
        updatedAt: episodes.updatedAt,
      })
      .from(episodes)
      .where(eq(episodes.id, id))
      .limit(1);

    if (rows.length === 0 || rows[0].archivedAt) {
      throw new NotFoundDomainError(`episode ${id} not found`);
    }
    const [hydrated] = await this.hydrate(rows);
    return hydrated;
  }

  private async hydrate(
    rows: Array<{
      id: string;
      summary: string | null;
      tags: string[] | null;
      confidence: number | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>,
  ): Promise<KnowledgeNode[]> {
    const ids = rows.map((row) => row.id);
    const memberRows = await this.db
      .select({
        episodeId: episodeMemories.episodeId,
        memoryId: episodeMemories.memoryId,
      })
      .from(episodeMemories)
      .where(inArray(episodeMemories.episodeId, ids));

    const memberMap = new Map<string, string[]>();
    for (const row of memberRows) {
      const list = memberMap.get(row.episodeId) ?? [];
      list.push(row.memoryId);
      memberMap.set(row.episodeId, list);
    }

    return rows.map((row) => ({
      id: row.id,
      summary: row.summary ?? "",
      tags: row.tags ?? [],
      confidence: row.confidence ?? null,
      supporting_memory_ids: memberMap.get(row.id) ?? [],
      created_at:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      updated_at:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : String(row.updatedAt),
    }));
  }
}
