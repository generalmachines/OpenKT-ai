import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// Read-only access for the graph endpoint. The data lives in three
// places:
//   - `memories`  — raw memory rows (Drizzle schema in this repo)
//   - `episodes` + `episode_memories` — synthesized clusters
//     (declared in migration 0004 but not in the Drizzle schema barrel
//      yet, so we read them with raw SQL via `db.execute(sql\`...\`)`)
//   - pgvector cosine similarity on `memories.embedding`
//
// Everything is filtered by `project_id` so a single graph call can
// only ever read nodes/edges that belong to a project the caller has
// already passed the membership check for.

export interface MemoryRow {
  id: string;
  content: string;
  kind: string | null;
  confidence: number | null;
  owner_user_id: string | null;
  archived: boolean;
  created_at: string;
}

export interface EpisodeRow {
  id: string;
  name: string;
  summary: string | null;
  member_count: number;
  created_at: string;
}

export interface EpisodeMemoryEdgeRow {
  episode_id: string;
  memory_id: string;
  similarity_at_join: number | null;
}

export interface SimilarityEdgeRow {
  source: string;
  target: string;
  similarity: number;
}

export interface ProjectFocusRow {
  id: string;
  org_id: string | null;
  owner_user_id: string;
}

@Injectable()
export class GraphRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getProjectFocus(projectId: string): Promise<ProjectFocusRow | null> {
    const result = await this.db.execute(
      sql`select id::text, org_id::text as org_id, owner_user_id::text as owner_user_id
            from projects
            where id = ${projectId}::uuid
            limit 1`,
    );
    const row = result.rows[0] as
      | { id: string; org_id: string | null; owner_user_id: string }
      | undefined;
    return row ?? null;
  }

  async listMemories(
    projectId: string,
    limit: number,
  ): Promise<MemoryRow[]> {
    const result = await this.db.execute(sql`
      select
        id::text as id,
        content,
        kind,
        confidence,
        owner_user_id::text as owner_user_id,
        archived,
        created_at::text as created_at
      from memories
      where project_id = ${projectId}::uuid
      order by created_at desc
      limit ${limit}
    `);
    return result.rows as unknown as MemoryRow[];
  }

  async listEpisodes(
    projectId: string,
    limit: number,
  ): Promise<EpisodeRow[]> {
    const result = await this.db.execute(sql`
      select
        id::text as id,
        name,
        summary,
        member_count,
        created_at::text as created_at
      from episodes
      where project_id = ${projectId}::uuid
      order by updated_at desc
      limit ${limit}
    `);
    return result.rows as unknown as EpisodeRow[];
  }

  async listEpisodeMemoryEdges(
    projectId: string,
    limit: number,
  ): Promise<EpisodeMemoryEdgeRow[]> {
    const result = await this.db.execute(sql`
      select
        em.episode_id::text as episode_id,
        em.memory_id::text as memory_id,
        em.similarity_at_join as similarity_at_join
      from episode_memories em
      join episodes e on e.id = em.episode_id
      where e.project_id = ${projectId}::uuid
      limit ${limit}
    `);
    return result.rows as unknown as EpisodeMemoryEdgeRow[];
  }

  // pgvector cosine similarity within a project. Returns symmetric
  // edges (source < target) deduplicated by ordering.
  async listSimilarityEdges(
    projectId: string,
    threshold: number,
    perNodeCap: number,
  ): Promise<SimilarityEdgeRow[]> {
    const result = await this.db.execute(sql`
      with ranked as (
        select
          m1.id::text as source,
          m2.id::text as target,
          (1 - (m1.embedding <=> m2.embedding))::real as similarity,
          row_number() over (
            partition by m1.id
            order by m1.embedding <=> m2.embedding asc
          ) as rn
        from memories m1
        join memories m2
          on m2.project_id = m1.project_id
         and m2.id <> m1.id
         and m2.embedding is not null
        where m1.project_id = ${projectId}::uuid
          and m1.embedding is not null
          and m1.archived = false
          and m2.archived = false
          and (1 - (m1.embedding <=> m2.embedding)) >= ${threshold}
      )
      select source, target, similarity
      from ranked
      where rn <= ${perNodeCap}
        and source < target
    `);
    return result.rows as unknown as SimilarityEdgeRow[];
  }
}
