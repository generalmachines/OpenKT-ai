import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  episodes,
  memories,
  projectBriefingCache,
} from "../../../db/schema";

// Drizzle-backed repository for briefings-v2.
//
// All access is by primary key (`project_id`); the briefing cache is a
// single-row-per-project table. Membership is checked at the
// application-service layer via `ProjectScopeService`, so this
// repository deliberately takes no `ActorContext` — it speaks only to
// the data tier.

export interface BriefingCacheRow {
  project_id: string;
  version: number;
  generated_at: string;
  stale_at: string | null;
  memory_count_at_generation: number;
  episode_count_at_generation: number;
  summary: string;
  themes: unknown[];
  key_decisions: unknown[];
  open_questions: unknown[];
  stats: Record<string, unknown>;
}

export interface ChangelogMemoryRow {
  id: string;
  kind: string;
  content: string;
  tags: string[];
  created_at: string;
  owner_user_id: string | null;
}

export interface ChangelogEpisodeRow {
  id: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ChangelogArchivedMemoryRow {
  id: string;
  archived_at: string;
}

export interface ChangelogSupersededEpisodeRow {
  id: string;
  archived_at: string;
}

@Injectable()
export class BriefingCacheRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getByProjectId(projectId: string): Promise<BriefingCacheRow | null> {
    const rows = await this.db
      .select()
      .from(projectBriefingCache)
      .where(eq(projectBriefingCache.projectId, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      project_id: row.projectId,
      version: row.version,
      generated_at: this.iso(row.generatedAt),
      stale_at: row.staleAt ? this.iso(row.staleAt) : null,
      memory_count_at_generation: row.memoryCountAtGeneration,
      episode_count_at_generation: row.episodeCountAtGeneration,
      summary: row.summary,
      themes: Array.isArray(row.themes) ? (row.themes as unknown[]) : [],
      key_decisions: Array.isArray(row.keyDecisions)
        ? (row.keyDecisions as unknown[])
        : [],
      open_questions: Array.isArray(row.openQuestions)
        ? (row.openQuestions as unknown[])
        : [],
      stats:
        row.stats && typeof row.stats === "object" && !Array.isArray(row.stats)
          ? (row.stats as Record<string, unknown>)
          : {},
    };
  }

  // Memories created (or updated) on/after `since`, not archived.
  async listNewMemoriesSince(
    projectId: string,
    since: Date,
  ): Promise<ChangelogMemoryRow[]> {
    // We use raw SQL for the tag-aggregation join — drizzle's typed
    // builder doesn't express "array_agg(t.slug)" without a lateral
    // boilerplate that obscures the intent.
    const rows = await this.db.execute<{
      id: string;
      kind: string;
      content: string;
      tags: string[] | null;
      created_at: string;
      owner_user_id: string | null;
    }>(sql`
      select m.id::text as id,
             m.kind::text as kind,
             m.content,
             coalesce(
               array(
                 select t.slug
                   from memory_tags mt
                   join tags t on t.id = mt.tag_id
                  where mt.memory_id = m.id
                  order by t.slug
               ),
               '{}'::text[]
             ) as tags,
             m.created_at::text as created_at,
             m.owner_user_id::text as owner_user_id
        from memories m
       where m.project_id = ${projectId}::uuid
         and m.archived = false
         and m.created_at >= ${since.toISOString()}::timestamptz
       order by m.created_at asc
       limit 200
    `);
    return (rows.rows ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      tags: Array.isArray(r.tags) ? r.tags : [],
      created_at: r.created_at,
      owner_user_id: r.owner_user_id,
    }));
  }

  async listArchivedMemoriesSince(
    projectId: string,
    since: Date,
  ): Promise<ChangelogArchivedMemoryRow[]> {
    // We don't track archive timestamps as a separate column, so
    // we approximate with `updated_at` for archived rows.
    const rows = await this.db
      .select({
        id: memories.id,
        archived_at: memories.updatedAt,
      })
      .from(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.archived, true),
          gte(memories.updatedAt, since),
        ),
      )
      .orderBy(asc(memories.updatedAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      archived_at: this.iso(r.archived_at),
    }));
  }

  async listNewEpisodesSince(
    projectId: string,
    since: Date,
  ): Promise<ChangelogEpisodeRow[]> {
    const rows = await this.db
      .select({
        id: episodes.id,
        summary: episodes.summary,
        created_at: episodes.createdAt,
        updated_at: episodes.updatedAt,
        archived_at: episodes.archivedAt,
      })
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
          gte(episodes.updatedAt, since),
          isNull(episodes.archivedAt),
        ),
      )
      .orderBy(asc(episodes.updatedAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      created_at: this.iso(r.created_at),
      updated_at: this.iso(r.updated_at),
      archived_at: r.archived_at ? this.iso(r.archived_at) : null,
    }));
  }

  async listSupersededEpisodesSince(
    projectId: string,
    since: Date,
  ): Promise<ChangelogSupersededEpisodeRow[]> {
    const rows = await this.db
      .select({
        id: episodes.id,
        archived_at: episodes.archivedAt,
      })
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
          isNotNull(episodes.archivedAt),
          gte(episodes.archivedAt, since),
        ),
      )
      .orderBy(asc(episodes.archivedAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      archived_at: r.archived_at ? this.iso(r.archived_at) : "",
    }));
  }

  // Helper: most recently created sibling episode in the same project,
  // used as a best-effort `superseded_by_episode_id` link for archived
  // episodes when the lineage column isn't tracked directly on the row.
  async findMostRecentActiveSibling(
    projectId: string,
    olderThan: Date,
  ): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: episodes.id })
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
          isNull(episodes.archivedAt),
          gte(episodes.createdAt, olderThan),
        ),
      )
      .orderBy(desc(episodes.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private iso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : String(value);
  }
}
