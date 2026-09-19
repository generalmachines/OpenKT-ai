import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  memories,
  memoryAccesses,
  memoryTags,
  orgMembers,
  profiles,
  projects,
  tags,
} from "../../../db/schema";
import type {
  CreateMemoryInput,
  ListMemoriesQuery,
  MemoryAccessSummary,
  MemoryListMeta,
  MemoryNeighborRecord,
  MemoryRecord,
  MemorySearchMeta,
  MemorySearchRequest,
  MemoryWithSimilarityRecord,
  RecallMeta,
} from "../contracts/memory.contract";
import { decayFieldsFromRecord } from "../services/memory-decay";
import { EMBEDDING_MODEL, embed, toPgVector } from "./embedding-bge";

// Single repository for everything memory-shaped. Uses Drizzle so the
// underlying database is whatever DATABASE_URL points at — the env-
// based repo swap that lived in the old memory.module.ts is now
// redundant. To verify against live data, point DATABASE_URL at the
// Supabase pg-pooler URL.
//
// Implemented:  list / find / create / forget / accessSummary /
//               logAccess / logAccessBatch
// Not yet:      search / recall — these need pgvector embeddings.
//               Throws loud so callers see exactly what's missing.

type MemoryAccessAction = "read" | "write" | "update" | "archive" | "recall";
type MemoryAccessSurface = "ui" | "api" | "cli" | "mcp";

@Injectable()
export class MemoryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async assertProjectMember(
    context: ActorContext,
    projectId: string,
  ): Promise<string> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");
    const rows = await this.db
      .select({ orgId: projects.orgId })
      .from(projects)
      .leftJoin(orgMembers, eq(orgMembers.orgId, projects.orgId))
      .where(
        and(
          eq(projects.id, projectId),
          or(
            eq(projects.ownerUserId, userId),
            and(eq(orgMembers.userId, userId), sql`${orgMembers.role} in ('owner', 'admin', 'member')`),
          ),
        ),
      )
      .limit(1);
    if (rows.length === 0) throw new NotFoundDomainError(`project ${projectId} not visible`);
    return rows[0].orgId ?? "";
  }

  async listByProject(
    context: ActorContext,
    input: ListMemoriesQuery,
  ): Promise<{ data: MemoryRecord[]; meta: MemoryListMeta }> {
    await this.assertProjectMember(context, input.project_id);

    const conditions = [eq(memories.projectId, input.project_id)];
    if (!input.include_archived) conditions.push(eq(memories.archived, false));
    if (input.kind) conditions.push(eq(memories.kind, input.kind));
    if (input.visibility) conditions.push(eq(memories.visibility, input.visibility));
    if (typeof input.min_confidence === "number")
      conditions.push(gte(memories.confidence, input.min_confidence));
    if (input.q) conditions.push(ilike(memories.content, `%${input.q}%`));
    if (input.tag) {
      const taggedIds = await this.db
        .select({ id: memoryTags.memoryId })
        .from(memoryTags)
        .innerJoin(tags, eq(tags.id, memoryTags.tagId))
        .where(eq(tags.slug, input.tag));
      const ids = taggedIds.map((r) => r.id);
      if (ids.length === 0) {
        return {
          data: [],
          meta: { total: 0, offset: input.offset, limit: input.limit, has_more: false },
        };
      }
      conditions.push(inArray(memories.id, ids));
    }
    const where = and(...conditions);

    const totalRow = await this.db.select({ n: count() }).from(memories).where(where);
    const total = Number(totalRow[0]?.n ?? 0);

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
      .where(where)
      .orderBy(desc(memories.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    const ids = rows.map((r) => r.m.id);
    const tagMap = await this.hydrateTags(ids);
    const data = rows.map((r) => this.toRecord(r, tagMap.get(r.m.id) ?? []));
    return {
      data,
      meta: { total, offset: input.offset, limit: input.limit, has_more: input.offset + data.length < total },
    };
  }

  // categorizedByProject returns top-N memories per kind, sorted by
  // importance DESC then created_at DESC. Used by /v1/prime when the
  // caller asks for `with_categorized=true` so harness session-start
  // hooks (kt prime) can render distinct sections — Decisions /
  // Anti-patterns / Incidents / etc — instead of a flat 50-row dump.
  //
  // K parallel queries (K = kinds.length, default 5). Each query is
  // index-served by (project_id, archived, kind) and limited to
  // perKindLimit rows; Postgres handles parallel reads on the same
  // hot index trivially. Auth is checked once up front; the per-kind
  // queries skip the redundant assertProjectMember round-trip.
  async categorizedByProject(
    context: ActorContext,
    projectId: string,
    kinds: MemoryRecord["kind"][],
    perKindLimit: number,
  ): Promise<Record<string, MemoryRecord[]>> {
    await this.assertProjectMember(context, projectId);
    if (kinds.length === 0 || perKindLimit <= 0) return {};

    const entries = await Promise.all(
      kinds.map(async (kind) => {
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
          .where(
            and(
              eq(memories.projectId, projectId),
              eq(memories.archived, false),
              eq(memories.kind, kind),
            ),
          )
          .orderBy(desc(memories.importance), desc(memories.createdAt))
          .limit(perKindLimit);

        const ids = rows.map((r) => r.m.id);
        const tagMap = await this.hydrateTags(ids);
        const data = rows.map((r) => this.toRecord(r, tagMap.get(r.m.id) ?? []));
        return [kind, data] as const;
      }),
    );
    return Object.fromEntries(entries.filter(([, data]) => data.length > 0));
  }

  async findById(_context: ActorContext, memoryId: string): Promise<MemoryRecord | null> {
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
      .where(eq(memories.id, memoryId))
      .limit(1);
    if (rows.length === 0) return null;
    const tagMap = await this.hydrateTags([rows[0].m.id]);
    return this.toRecord(rows[0], tagMap.get(rows[0].m.id) ?? []);
  }

  // Bulk hydrate memories by id (preserving caller-supplied order).
  // Used when a caller holds a ranked list of memory ids that need
  // wrapping in the MemoryRecord shape.
  async findByIds(
    _context: ActorContext,
    memoryIds: string[],
  ): Promise<MemoryRecord[]> {
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
    if (rows.length === 0) return [];
    const tagMap = await this.hydrateTags(rows.map((r) => r.m.id));
    const byId = new Map<string, MemoryRecord>();
    for (const row of rows) {
      byId.set(row.m.id, this.toRecord(row, tagMap.get(row.m.id) ?? []));
    }
    return memoryIds.map((id) => byId.get(id)).filter((m): m is MemoryRecord => !!m);
  }

  async findDuplicate(
    context: ActorContext,
    projectId: string,
    content: string,
  ): Promise<MemoryRecord | null> {
    await this.assertProjectMember(context, projectId);
    const rows = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.content, content),
          eq(memories.archived, false),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return this.findById(context, rows[0].id);
  }

  async create(
    context: ActorContext,
    projectId: string,
    orgId: string | null,
    input: CreateMemoryInput,
    sessionStamp?: { sessionId: string; source: string } | null,
  ): Promise<MemoryRecord> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");
    const resolvedOrgId = orgId;

    const inserted = await this.db
      .insert(memories)
      .values({
        orgId: resolvedOrgId,
        projectId,
        ownerUserId: userId,
        content: input.content,
        kind: input.kind,
        category: input.category,
        visibility: input.visibility,
        confidence: input.confidence,
        importance: input.importance,
        sourceRefs: input.source_refs ?? [],
        archived: false,
        sessionId: sessionStamp?.sessionId ?? null,
        source: sessionStamp?.source ?? null,
      })
      .returning({ id: memories.id });
    if (!inserted[0]) throw new ValidationDomainError("memory create failed");

    if (input.tag_slugs && input.tag_slugs.length > 0) {
      await this.attachTags(resolvedOrgId, userId, inserted[0].id, input.tag_slugs);
    }

    // Bump the owning project's updated_at so dashboard "last activity"
    // reflects reality without a separate scan over memories. Fire-and-
    // forget — if the bump fails (concurrent DDL etc.) the memory was
    // already written.
    void this.db
      .update(projects)
      .set({ updatedAt: sql`now()` })
      .where(eq(projects.id, projectId))
      .catch(() => undefined);

    const shaped = await this.findById(context, inserted[0].id);
    if (!shaped) throw new ValidationDomainError("memory read-after-write failed");
    return shaped;
  }

  private async attachTags(
    orgId: string | null,
    userId: string,
    memoryId: string,
    slugs: string[],
  ): Promise<void> {
    for (const slug of slugs) {
      if (!orgId) continue;
      const existing = await this.db
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.slug, slug))
        .limit(1);
      let tagId = existing[0]?.id;
      if (!tagId) {
        const [created] = await this.db
          .insert(tags)
          .values({ slug, displayName: slug, orgId, ownerUserId: null })
          .returning({ id: tags.id });
        tagId = created?.id;
      }
      if (!tagId) continue;
      await this.db
        .insert(memoryTags)
        .values({ memoryId, tagId })
        .onConflictDoNothing();
    }
  }

  async forget(_context: ActorContext, memoryId: string, hard: boolean): Promise<void> {
    if (hard) {
      await this.db.delete(memories).where(eq(memories.id, memoryId));
    } else {
      await this.db
        .update(memories)
        .set({ archived: true, updatedAt: new Date() })
        .where(eq(memories.id, memoryId));
    }
  }

  async accessSummary(_context: ActorContext, memoryId: string): Promise<MemoryAccessSummary> {
    const rows = await this.db.execute(
      sql`SELECT
            count(distinct actor_user_id)::int AS viewer_count,
            count(*) FILTER (WHERE action = 'recall')::int AS recall_count,
            max(at) FILTER (WHERE action = 'recall')::text AS last_recall_at,
            max(at) FILTER (WHERE action = 'read')::text  AS last_view_at
          FROM ${memoryAccesses} WHERE memory_id = ${memoryId}::uuid`,
    );
    const r = rows.rows[0] as {
      viewer_count: number;
      recall_count: number;
      last_recall_at: string | null;
      last_view_at: string | null;
    } | undefined;
    return {
      viewer_count: r?.viewer_count ?? 0,
      recall_count: r?.recall_count ?? 0,
      last_recall_at: r?.last_recall_at ?? null,
      last_view_at: r?.last_view_at ?? null,
      top_viewers: [],
    };
  }

  async logAccess(
    context: ActorContext,
    memoryId: string,
    action: MemoryAccessAction,
    surface: MemoryAccessSurface = "api",
  ): Promise<void> {
    await this.db.insert(memoryAccesses).values({
      memoryId,
      actorUserId: context.principal.userId ?? null,
      action,
      surface,
    });
  }

  async logAccessBatch(
    context: ActorContext,
    memoryIds: string[],
    action: MemoryAccessAction,
    surface: MemoryAccessSurface = "api",
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    const userId = context.principal.userId ?? null;
    await this.db.insert(memoryAccesses).values(
      memoryIds.map((id) => ({ memoryId: id, actorUserId: userId, action, surface })),
    );
  }

  async search(
    _context: ActorContext,
    request: MemorySearchRequest,
    workspaceIds: string[],
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta }> {
    const start = Date.now();
    const projectIds = request.filters.project_ids ?? [];
    const allProjectIds = Array.from(new Set([...projectIds, ...workspaceIds]));
    if (allProjectIds.length === 0) {
      return {
        data: [],
        meta: this.buildSearchMeta({
          totalMatched: 0,
          mode: request.mode,
          vectorWeight: request.vector_weight,
          workspaceWeight: request.workspace_weight,
          workspaceSize: workspaceIds.length,
          queryMs: Date.now() - start,
        }),
      };
    }

    const queryEmbedding =
      request.mode === "keyword" || !request.query.trim()
        ? null
        : await embed(request.query);
    const queryVector = queryEmbedding ? toPgVector(queryEmbedding) : null;

    const conditions = [
      inArray(memories.projectId, allProjectIds),
    ] as ReturnType<typeof eq>[];
    if (!request.filters.include_archived) {
      conditions.push(eq(memories.archived, false));
    }
    if (!request.filters.include_superseded) {
      conditions.push(sql`${memories.supersededBy} is null` as ReturnType<typeof eq>);
    }
    if (request.filters.kinds && request.filters.kinds.length > 0) {
      conditions.push(inArray(memories.kind, request.filters.kinds));
    }
    if (typeof request.filters.min_confidence === "number") {
      conditions.push(
        sql`${memories.confidence} >= ${request.filters.min_confidence}` as ReturnType<typeof eq>,
      );
    }
    if (request.query.trim() && (request.mode === "keyword" || !queryVector)) {
      conditions.push(ilike(memories.content, `%${request.query}%`));
    }

    const orderClause = queryVector
      ? sql`embedding <=> ${queryVector}::vector asc`
      : desc(memories.createdAt);

    const rawRows = await this.db
      .select({
        m: memories,
        projectSlug: projects.slug,
        projectName: projects.name,
        projectVisibility: projects.visibility,
        ownerEmail: profiles.email,
        ownerDisplayName: profiles.displayName,
        similarity: queryVector
          ? sql<number>`1 - (embedding <=> ${queryVector}::vector)`
          : sql<number | null>`null::float`,
      })
      .from(memories)
      .innerJoin(projects, eq(projects.id, memories.projectId))
      .leftJoin(profiles, eq(profiles.userId, memories.ownerUserId))
      .where(and(...conditions))
      .orderBy(orderClause)
      .limit(request.limit);

    const ids = rawRows.map((r) => r.m.id);
    const tagMap = await this.hydrateTags(ids);
    const data: MemoryWithSimilarityRecord[] = rawRows.map((r) => {
      const base = this.toRecord(
        {
          m: r.m,
          projectSlug: r.projectSlug,
          projectName: r.projectName,
          projectVisibility: r.projectVisibility,
          ownerEmail: r.ownerEmail,
          ownerDisplayName: r.ownerDisplayName,
        },
        tagMap.get(r.m.id) ?? [],
      );
      const similarity =
        typeof r.similarity === "number" ? Math.max(0, Math.min(1, r.similarity)) : null;
      const isPrimary =
        projectIds.length === 0 || projectIds.includes(base.project_id);
      return {
        ...base,
        similarity,
        source_scope: isPrimary ? ("primary" as const) : ("workspace" as const),
        effective_importance: base.importance,
      };
    });

    return {
      data,
      meta: this.buildSearchMeta({
        totalMatched: data.length,
        mode: request.mode,
        vectorWeight: queryEmbedding ? request.vector_weight : null,
        workspaceWeight: request.workspace_weight,
        workspaceSize: workspaceIds.length,
        queryMs: Date.now() - start,
      }),
    };
  }

  /**
   * Fetch the pre-computed semantic neighbors for a memory. Reads from
   * `memory_neighbors` (populated by the worker's neighbors stage) and
   * hydrates each row with a content preview + the tag list, so the UI
   * can render a "related memories" panel without a second round-trip.
   *
   * Returns an empty array if the stage hasn't yet run for this memory.
   */
  async neighbors(
    memoryId: string,
    limit: number,
    minSimilarity: number,
  ): Promise<MemoryNeighborRecord[]> {
    const result = await this.db.execute(sql`
      select
        n.neighbor_memory_id::text as id,
        m.kind as kind,
        substring(m.content for 200) as content_preview,
        n.similarity::float as similarity,
        n.computed_at::text as computed_at
      from memory_neighbors n
      join memories m on m.id = n.neighbor_memory_id
      where n.memory_id = ${memoryId}::uuid
        and n.similarity >= ${minSimilarity}
        and m.archived = false
      order by n.similarity desc
      limit ${limit}
    `);
    const rows = result.rows as Array<{
      id: string;
      kind: string;
      content_preview: string;
      similarity: number;
      computed_at: string;
    }>;
    if (rows.length === 0) return [];
    const neighborIds = rows.map((r) => r.id);
    const tagMap = await this.hydrateTags(neighborIds);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as MemoryNeighborRecord["kind"],
      content_preview: (row.content_preview ?? "").replace(/\s+/g, " ").trim(),
      tags: tagMap.get(row.id) ?? [],
      similarity: Number(row.similarity),
      computed_at: row.computed_at,
    }));
  }

  /**
   * Lazy neighbors compute. For each memory id passed in, check whether
   * its `memory_neighbors` rows are missing or stale (older than 24h),
   * and if so, run the pgvector top-N self-join inline and upsert both
   * directions of the relation.
   *
   * Replaces the worker's pre-compute neighbors stage that used to fan
   * out per memory. Driven by the recall path — if a memory shows up
   * in a recall result, we make sure its neighbors panel is fresh for
   * the trace/UI; otherwise we don't pay for the compute.
   *
   * Idempotent + safe to call from a fire-and-forget context: failures
   * are swallowed (the recall response shape doesn't depend on
   * neighbors being computed) so a transient pgvector hiccup never
   * surfaces as a recall 500. Logs once if it does fail.
   */
  async ensureNeighborsFresh(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    const TOP_N = 20;
    const MIN_SIMILARITY = 0.5;
    const TTL_HOURS = 24;

    try {
      // Pick out the memories that either have no neighbor row yet or
      // whose freshest row is older than TTL_HOURS. We rely on the
      // partial index `memory_neighbors_lookup_idx` for the max() lookup;
      // worst case the join is cheap for the recall page size (≤ 50
      // memories).
      //
      // Each id is bound as its own parameter inside ARRAY[...] — a JS
      // array interpolated into sql`` expands to a parenthesized param
      // list `($1, $2, ...)`, which Postgres treats as a record and
      // refuses to cast ("cannot cast type record to uuid[]"). Same
      // idiom as local-memory-engine.service.ts.
      const idList = sql.join(
        memoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const result = await this.db.execute(sql`
        with input(id) as (
          select unnest(array[${idList}])
        ),
        staleness as (
          select i.id::uuid as memory_id,
                 max(n.computed_at) as latest_computed_at
            from input i
            left join memory_neighbors n on n.memory_id = i.id::uuid
           group by i.id
        )
        select s.memory_id::text as memory_id,
               m.project_id::text as project_id,
               m.embedding::text  as embedding
          from staleness s
          join memories m on m.id = s.memory_id
         where m.archived = false
           and m.embedding is not null
           and (
             s.latest_computed_at is null
             or s.latest_computed_at < now() - (${TTL_HOURS} || ' hours')::interval
           )
      `);
      const rows = result.rows as Array<{
        memory_id: string;
        project_id: string;
        embedding: string;
      }>;
      if (rows.length === 0) return;

      for (const row of rows) {
        await this.recomputeNeighborsFor(
          row.memory_id,
          row.project_id,
          row.embedding,
          TOP_N,
          MIN_SIMILARITY,
        );
      }
    } catch (error) {
      // Recall is the primary path — never let a neighbors compute
      // failure bubble up. Log + move on; next recall touching the
      // same memory will retry. Error level on purpose: this swallow
      // hid a permanent SQL bug (record→uuid[] cast, os-sts1) for
      // hours because warn-level lines never tripped log alarms.
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.constructor.name : "Unknown";
      // eslint-disable-next-line no-console
      console.error(
        `[memory.recall] ensureNeighborsFresh failed (swallowed by design) memory_ids=${memoryIds.length} err=${name}: ${message}`,
      );
    }
  }

  private async recomputeNeighborsFor(
    memoryId: string,
    projectId: string,
    embeddingText: string,
    topN: number,
    minSimilarity: number,
  ): Promise<void> {
    const candidatesResult = await this.db.execute(sql`
      select id::text as neighbor_id,
             (1 - (embedding <=> ${embeddingText}::vector))::real as similarity
        from memories
       where project_id = ${projectId}::uuid
         and id <> ${memoryId}::uuid
         and embedding is not null
         and archived = false
       order by embedding <=> ${embeddingText}::vector asc
       limit ${topN}
    `);
    const candidates = (
      candidatesResult.rows as Array<{ neighbor_id: string; similarity: number }>
    )
      .map((row) => ({
        neighbor_id: row.neighbor_id,
        similarity: clampUnit(Number(row.similarity)),
      }))
      .filter((row) => row.similarity >= minSimilarity);

    // Idempotent replace of the forward direction; reverse rows are
    // refreshed via upsert (we don't clear other memories' forward sets).
    await this.db.execute(
      sql`delete from memory_neighbors where memory_id = ${memoryId}::uuid`,
    );
    for (const candidate of candidates) {
      await this.db.execute(sql`
        insert into memory_neighbors (memory_id, neighbor_memory_id, similarity)
        values (${memoryId}::uuid, ${candidate.neighbor_id}::uuid, ${candidate.similarity})
        on conflict (memory_id, neighbor_memory_id)
        do update set similarity = excluded.similarity,
                      computed_at = now()
      `);
      await this.db.execute(sql`
        insert into memory_neighbors (memory_id, neighbor_memory_id, similarity)
        values (${candidate.neighbor_id}::uuid, ${memoryId}::uuid, ${candidate.similarity})
        on conflict (memory_id, neighbor_memory_id)
        do update set similarity = excluded.similarity,
                      computed_at = now()
      `);
    }
  }

  async recall(
    context: ActorContext,
    searchResult: { data: MemoryWithSimilarityRecord[]; meta: MemorySearchMeta },
    invocationId?: string,
  ): Promise<{ data: MemoryWithSimilarityRecord[]; meta: RecallMeta }> {
    const start = Date.now();
    if (searchResult.data.length > 0) {
      const userId = context.principal.userId ?? null;
      await this.db.insert(memoryAccesses).values(
        searchResult.data.map((row) => ({
          memoryId: row.id,
          actorUserId: userId,
          action: "recall" as const,
          surface: "api" as const,
          invocationId: invocationId ?? null,
        })),
      );
    }
    return { data: searchResult.data, meta: { query_ms: Date.now() - start } };
  }

  private buildSearchMeta(opts: {
    totalMatched: number;
    mode: string;
    vectorWeight: number | null;
    workspaceWeight: number;
    workspaceSize: number;
    queryMs: number;
  }): MemorySearchMeta {
    return {
      total_matched: opts.totalMatched,
      mode: opts.mode as MemorySearchMeta["mode"],
      vector_weight: opts.vectorWeight,
      embedding_model: EMBEDDING_MODEL,
      next_cursor: null,
      query_ms: opts.queryMs,
      workspace_weight: opts.workspaceWeight,
      workspace_size: opts.workspaceSize,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────

  private async hydrateTags(
    memoryIds: string[],
  ): Promise<Map<string, { id: string; slug: string; display_name: string }[]>> {
    if (memoryIds.length === 0) return new Map();
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
    for (const r of rows) {
      const list = map.get(r.memoryId) ?? [];
      list.push({ id: r.id, slug: r.slug, display_name: r.displayName });
      map.set(r.memoryId, list);
    }
    return map;
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
      last_accessed_at:
        m.lastRecallAt instanceof Date ? m.lastRecallAt.toISOString() : m.lastRecallAt,
      source_refs: Array.isArray(m.sourceRefs)
        ? (m.sourceRefs as MemoryRecord["source_refs"])
        : [],
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

  // Used by SessionsApplicationService (GET /v1/sessions/:id) to show
  // the memories distilled from one session. Provided directly on
  // this repository (not the application service) so the sessions
  // module can depend on the class itself — which only needs the
  // globally-provided DRIZZLE token — without importing MemoryModule
  // and creating a module-level cycle (MemoryModule already depends
  // on the sessions repository for save-time stamping).
  async findBySessionId(sessionId: string): Promise<MemoryRecord[]> {
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
      .where(eq(memories.sessionId, sessionId))
      .orderBy(desc(memories.createdAt));
    if (rows.length === 0) return [];
    const tagMap = await this.hydrateTags(rows.map((r) => r.m.id));
    return rows.map((row) => this.toRecord(row, tagMap.get(row.m.id) ?? []));
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
