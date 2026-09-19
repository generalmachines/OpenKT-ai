import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { requireMemoryReadAccess } from "@openkt/auth-authorization";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// The trace endpoint stitches together the pipeline's footprint for a
// single memory:
//
//   1. The base memory row (already authorized by the caller).
//   2. Each `agentic_jobs` row keyed by memory_id, ordered by stage
//      sequence. We map the worker's `kind` -> the contract's
//      `stage` label and roll status/timing from the row.
//   3. The resulting episode (if `episode_memories` linked one),
//      flagged with `synthesis_action: 'join' | 'create'` based on
//      whether this memory's `episode_memories.added_at` matches the
//      episode's `created_at`.
//   4. Top-K similar memories via pgvector cosine, threshold 0.80.
//
// All raw SQL on tables that aren't yet in the Drizzle schema barrel
// (episodes, episode_memories, agentic_jobs) — see migrations 0003
// and 0004.

export type TraceStageName =
  | "preprocess"
  | "embed"
  | "triage"
  | "synthesize"
  | "episode"
  | "member_knowledge_synthesis"
  | "briefing";

export type TraceStageStatus = "pending" | "running" | "completed" | "failed";

export interface TraceLlmCall {
  id: string;
  provider: string;
  model: string;
  prompt_messages: Array<{ role: string; content: string }> | null;
  response_text: string | null;
  response_metadata: Record<string, unknown> | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  status: string;
  error_reason: string | null;
  truncated: boolean;
  created_at: string;
}

export type TraceStageScope = "memory" | "project";

export interface TraceStage {
  stage: TraceStageName;
  // Pipeline scope of the stage. "memory" stages are keyed by
  // agentic_jobs.memory_id; "project" stages (briefing,
  // member_knowledge_synthesis) fire fleet-wide and aren't linked to
  // a single memory in the DB. We surface project-scoped stages that
  // ran within the memory's processing window so the UI can render a
  // complete pipeline picture (e.g. "this memory was ingested; 12s
  // later the project briefing fired"). Default is "memory".
  scope: TraceStageScope;
  status: TraceStageStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  output: unknown;
  error_reason: string | null;
  // Migration 0025 — surface every llm_calls row that was made under
  // this memory + stage. The trace UI uses these to show what prompt
  // the LLM saw and what response it returned. response_text is
  // truncated to TRACE_RESPONSE_DISPLAY_MAX_CHARS here so the JSON
  // payload stays reasonable even when the recorder stored a larger
  // body; full text remains available via the dedicated llm_calls
  // query endpoint.
  llm_calls: TraceLlmCall[];
}

export interface TraceMemorySummary {
  id: string;
  kind: string | null;
  content_preview: string;
  tags: string[];
  confidence: number | null;
  created_at: string;
  actor_id: string | null;
  project_id: string;
}

export interface TraceEpisode {
  id: string;
  summary: string | null;
  synthesis_action: "create" | "join" | "extend" | "supersede" | "fork";
  supersedes_episode_id: string | null;
  tags: string[];
  confidence: number | null;
}

export interface TraceRelatedMemory {
  id: string;
  preview: string;
  similarity: number;
  relation: "near_duplicate" | "in_same_episode" | "superseded_by_same_episode";
}

export interface TraceSemanticNeighbor {
  id: string;
  preview: string;
  similarity: number;
  computed_at: string;
}

export interface MemoryTraceResponse {
  memory: TraceMemorySummary;
  stages: TraceStage[];
  resulting_episode: TraceEpisode | null;
  related_memories: TraceRelatedMemory[];
  // Pre-computed semantic neighbors from `memory_neighbors`. Populated
  // by the worker's neighbors stage after embed. May be empty if the
  // stage hasn't run yet (older memories pre-dating the stage).
  semantic_neighbors: TraceSemanticNeighbor[];
  timing: {
    total_ms: number | null;
    started_at: string | null;
    completed_at: string | null;
  };
}

const STAGE_FROM_JOB_KIND: Record<string, TraceStageName> = {
  preprocess: "preprocess",
  embed: "embed",
  triage: "triage",
  synthesize: "synthesize",
  episode: "episode",
  // The worker's recorder uses "manual" as a fallback stage when no
  // context is set — we don't map it to a trace stage so it stays out
  // of per-stage llm_calls. The dashboard's llm_calls list view will
  // still surface those rows under the dedicated query API.
  member_knowledge_synthesis: "member_knowledge_synthesis",
  briefing: "briefing",
};

const STAGE_ORDER: TraceStageName[] = [
  "preprocess",
  "embed",
  "triage",
  "synthesize",
  "episode",
  "member_knowledge_synthesis",
  "briefing",
];

const RESULT_PAYLOAD_MAX_CHARS = 5_000;
const RELATED_LIMIT = 5;
const RELATED_THRESHOLD = 0.8;
// Worker stages that fire at the project level (no memory_id) and are
// stitched into a memory's trace if they ran during the memory's
// processing window. Keep in sync with STAGE_FROM_JOB_KIND above.
const PROJECT_SCOPED_STAGE_KINDS = ["briefing", "member_knowledge_synthesis"] as const;
// Padding applied to the memory's processing window when looking up
// project-scoped jobs. Workers fan out asynchronously so a briefing
// that fired ~60s after the last memory-scoped stage is still part of
// the same logical pipeline iteration.
const PROJECT_STAGE_WINDOW_PAD_MS = 60_000;
// Display-side cap for llm_calls.response_text on the trace endpoint.
// The recorder stores up to ~64KB in the DB; the trace response trims
// to 5KB so a single dashboard tile renders without a multi-megabyte
// payload. Full text remains available via /v1/observability/llm_calls.
const TRACE_RESPONSE_DISPLAY_MAX_CHARS = 5_000;

@Injectable()
export class MemoryTraceService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async trace(
    context: ActorContext,
    memoryId: string,
  ): Promise<MemoryTraceResponse> {
    // Authorization + existence in one call. Throws NotFound if the
    // memory doesn't exist or isn't visible to the caller.
    await requireMemoryReadAccess(context, memoryId);

    const memory = await this.loadMemory(memoryId);
    const tagsP = this.loadTagSlugs(memoryId);
    const jobsP = this.loadJobs(memoryId);
    const episodeP = this.loadResultingEpisode(memoryId);
    const relatedP = this.loadRelatedMemories(memoryId, memory.projectId);
    const llmCallsP = this.loadLlmCallsByStage(memoryId);
    const neighborsP = this.loadSemanticNeighbors(memoryId);

    const [tags, jobs, episode, related, llmCallsByStage, neighbors] = await Promise.all([
      tagsP,
      jobsP,
      episodeP,
      relatedP,
      llmCallsP,
      neighborsP,
    ]);

    // Look for project-scoped stages (briefing,
    // member_knowledge_synthesis) that fired during this memory's
    // processing window. Those jobs aren't keyed by memory_id but the
    // UI wants to render them inline so users see the full pipeline.
    const projectJobs = await this.loadProjectScopedJobs(
      memory.projectId,
      jobs,
      memory.createdAt,
    );

    const stages = this.buildStages(jobs, projectJobs, llmCallsByStage);
    // Timing reflects the memory's own footprint; project-scoped stages
    // are co-occurrence info and don't count toward the per-memory
    // pipeline duration.
    const timing = this.computeTiming(jobs);

    return {
      memory: {
        id: memory.id,
        kind: memory.kind,
        content_preview: previewText(memory.content),
        tags,
        confidence: memory.confidence,
        created_at: memory.createdAt,
        actor_id: memory.ownerUserId,
        project_id: memory.projectId,
      },
      stages,
      resulting_episode: episode,
      related_memories: related,
      semantic_neighbors: neighbors,
      timing,
    };
  }

  private async loadSemanticNeighbors(
    memoryId: string,
  ): Promise<TraceSemanticNeighbor[]> {
    // Pulls from the pre-computed `memory_neighbors` table populated
    // by the worker's neighbors stage. No LLM call, no pgvector scan —
    // this is just an indexed lookup. The related_memories field above
    // remains as a fallback for the pre-stage data.
    const result = await this.db.execute(sql`
      select
        n.neighbor_memory_id::text as id,
        substring(m.content for 200) as preview,
        n.similarity::float as similarity,
        n.computed_at::text as computed_at
      from memory_neighbors n
      join memories m on m.id = n.neighbor_memory_id
      where n.memory_id = ${memoryId}::uuid
      order by n.similarity desc
      limit 20
    `);
    const rows = result.rows as Array<{
      id: string;
      preview: string;
      similarity: number;
      computed_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      preview: previewText(row.preview),
      similarity: Number(row.similarity),
      computed_at: row.computed_at,
    }));
  }

  // ── data access ──────────────────────────────────────────────────

  private async loadMemory(memoryId: string): Promise<{
    id: string;
    kind: string | null;
    content: string;
    confidence: number | null;
    createdAt: string;
    ownerUserId: string | null;
    projectId: string;
  }> {
    const result = await this.db.execute(sql`
      select
        id::text as id,
        kind,
        content,
        confidence,
        created_at::text as created_at,
        owner_user_id::text as owner_user_id,
        project_id::text as project_id
      from memories
      where id = ${memoryId}::uuid
      limit 1
    `);
    const row = result.rows[0] as
      | {
          id: string;
          kind: string | null;
          content: string;
          confidence: number | string | null;
          created_at: string;
          owner_user_id: string | null;
          project_id: string;
        }
      | undefined;
    if (!row) {
      // Shouldn't happen because requireMemoryReadAccess already ran,
      // but belt-and-suspenders for race conditions.
      throw new Error("memory disappeared between authz and trace load");
    }
    return {
      id: row.id,
      kind: row.kind,
      content: row.content ?? "",
      confidence: row.confidence === null ? null : Number(row.confidence),
      createdAt: row.created_at,
      ownerUserId: row.owner_user_id,
      projectId: row.project_id,
    };
  }

  private async loadTagSlugs(memoryId: string): Promise<string[]> {
    const result = await this.db.execute(sql`
      select t.slug
      from memory_tags mt
      join tags t on t.id = mt.tag_id
      where mt.memory_id = ${memoryId}::uuid
      order by t.slug
    `);
    return (result.rows as Array<{ slug: string }>).map((row) => row.slug);
  }

  // Loads agentic_jobs rows for stages that run at the project level
  // (briefing, member_knowledge_synthesis) and overlap with this
  // memory's processing window. The window is derived from the
  // memory-scoped jobs we already loaded: [min(started_at), max(coalesce(
  // completed_at, started_at, created_at))] padded by ±60s. We fall
  // back to the memory's created_at when the memory-scoped jobs have
  // no timing yet (e.g. still queued).
  private async loadProjectScopedJobs(
    projectId: string,
    memoryJobs: JobRow[],
    memoryCreatedAt: string,
  ): Promise<JobRow[]> {
    const { startMs, endMs } = computeJobWindow(memoryJobs, memoryCreatedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    const lowerIso = new Date(startMs - PROJECT_STAGE_WINDOW_PAD_MS).toISOString();
    const upperIso = new Date(endMs + PROJECT_STAGE_WINDOW_PAD_MS).toISOString();
    const kinds = PROJECT_SCOPED_STAGE_KINDS.map((k) => `'${k}'`).join(",");
    const result = await this.db.execute(sql`
      select
        id::text as id,
        kind,
        stage,
        status,
        started_at::text as started_at,
        completed_at::text as completed_at,
        created_at::text as created_at,
        result,
        error
      from agentic_jobs
      where project_id = ${projectId}::uuid
        and memory_id is null
        and kind in (${sql.raw(kinds)})
        and started_at between ${lowerIso}::timestamptz and ${upperIso}::timestamptz
      order by created_at asc
    `);
    return result.rows as unknown as JobRow[];
  }

  private async loadJobs(memoryId: string): Promise<JobRow[]> {
    const result = await this.db.execute(sql`
      select
        id::text as id,
        kind,
        stage,
        status,
        started_at::text as started_at,
        completed_at::text as completed_at,
        created_at::text as created_at,
        result,
        error
      from agentic_jobs
      where memory_id = ${memoryId}::uuid
      order by created_at asc
    `);
    return result.rows as unknown as JobRow[];
  }

  private async loadResultingEpisode(
    memoryId: string,
  ): Promise<TraceEpisode | null> {
    const result = await this.db.execute(sql`
      select
        e.id::text as id,
        e.summary,
        e.created_at::text as created_at,
        em.added_at::text as added_at,
        em.similarity_at_join
      from episode_memories em
      join episodes e on e.id = em.episode_id
      where em.memory_id = ${memoryId}::uuid
      order by em.added_at desc
      limit 1
    `);
    const row = result.rows[0] as
      | {
          id: string;
          summary: string | null;
          created_at: string;
          added_at: string;
          similarity_at_join: number | string | null;
        }
      | undefined;
    if (!row) return null;
    // A memory "created" the episode when its membership timestamp is
    // within 100ms of the episode row's created_at; everything later is
    // a join. The synthesize service in the worker writes both in the
    // same statement, so they match for the founder memory.
    const createdAtMs = Date.parse(row.created_at);
    const addedAtMs = Date.parse(row.added_at);
    const action: TraceEpisode["synthesis_action"] =
      Number.isFinite(createdAtMs) &&
      Number.isFinite(addedAtMs) &&
      Math.abs(createdAtMs - addedAtMs) < 100
        ? "create"
        : "join";
    return {
      id: row.id,
      summary: row.summary,
      synthesis_action: action,
      supersedes_episode_id: null,
      tags: [],
      confidence:
        row.similarity_at_join === null ? null : Number(row.similarity_at_join),
    };
  }

  private async loadRelatedMemories(
    memoryId: string,
    projectId: string,
  ): Promise<TraceRelatedMemory[]> {
    const result = await this.db.execute(sql`
      with target as (
        select embedding from memories where id = ${memoryId}::uuid
      )
      select
        m.id::text as id,
        substring(m.content for 160) as preview,
        (1 - (m.embedding <=> t.embedding))::real as similarity
      from memories m, target t
      where m.project_id = ${projectId}::uuid
        and m.id <> ${memoryId}::uuid
        and m.embedding is not null
        and t.embedding is not null
        and (1 - (m.embedding <=> t.embedding)) >= ${RELATED_THRESHOLD}
      order by m.embedding <=> t.embedding asc
      limit ${RELATED_LIMIT}
    `);
    const rows = result.rows as Array<{
      id: string;
      preview: string;
      similarity: number;
    }>;

    if (rows.length === 0) return [];

    // Decorate with the relation kind by checking shared-episode
    // membership. Anything left over is "near_duplicate".
    const sharedEpisodeIds = await this.loadSharedEpisodeMemberIds(memoryId);
    return rows.map((row) => ({
      id: row.id,
      preview: previewText(row.preview),
      similarity: Number(row.similarity),
      relation: sharedEpisodeIds.has(row.id)
        ? ("in_same_episode" as const)
        : ("near_duplicate" as const),
    }));
  }

  private async loadSharedEpisodeMemberIds(
    memoryId: string,
  ): Promise<Set<string>> {
    const result = await this.db.execute(sql`
      select distinct em2.memory_id::text as memory_id
      from episode_memories em1
      join episode_memories em2 on em2.episode_id = em1.episode_id
      where em1.memory_id = ${memoryId}::uuid
        and em2.memory_id <> ${memoryId}::uuid
    `);
    return new Set(
      (result.rows as Array<{ memory_id: string }>).map((row) => row.memory_id),
    );
  }

  // ── stage assembly ───────────────────────────────────────────────

  private buildStages(
    jobs: JobRow[],
    projectJobs: JobRow[],
    llmCallsByStage: Map<string, TraceLlmCall[]>,
  ): TraceStage[] {
    const byStage = new Map<TraceStageName, JobRow>();
    for (const job of jobs) {
      const stageName =
        (job.stage && this.normalizeStage(job.stage)) ??
        STAGE_FROM_JOB_KIND[job.kind ?? ""] ??
        null;
      if (!stageName) continue;
      // Keep the latest attempt; rows are sorted asc by created_at so
      // overwriting gives us the freshest status.
      byStage.set(stageName, job);
    }

    // Project-scoped stages: keyed separately so a project briefing
    // doesn't clobber (or get clobbered by) a memory-scoped row with
    // the same stage name (defensive — current pipeline never mixes
    // these two scopes on the same stage name, but the trace assembly
    // shouldn't depend on that invariant holding forever).
    const byProjectStage = new Map<TraceStageName, JobRow>();
    for (const job of projectJobs) {
      const stageName =
        (job.stage && this.normalizeStage(job.stage)) ??
        STAGE_FROM_JOB_KIND[job.kind ?? ""] ??
        null;
      if (!stageName) continue;
      byProjectStage.set(stageName, job);
    }

    const stages: TraceStage[] = [];
    for (const stageName of STAGE_ORDER) {
      const memoryJob = byStage.get(stageName);
      if (memoryJob) {
        const llmCalls = llmCallsByStage.get(stageName) ?? [];
        stages.push(this.toStage(stageName, memoryJob, llmCalls, "memory"));
        // If the same stage name also exists project-side (rare today),
        // surface it as a distinct project-scoped row right after the
        // memory-scoped one.
        const projectJob = byProjectStage.get(stageName);
        if (projectJob) {
          stages.push(this.toStage(stageName, projectJob, [], "project"));
        }
        continue;
      }
      const projectJob = byProjectStage.get(stageName);
      if (projectJob) {
        stages.push(this.toStage(stageName, projectJob, [], "project"));
      }
    }
    return stages;
  }

  private normalizeStage(stage: string): TraceStageName | null {
    if (STAGE_ORDER.includes(stage as TraceStageName)) {
      return stage as TraceStageName;
    }
    return STAGE_FROM_JOB_KIND[stage] ?? null;
  }

  private toStage(
    stageName: TraceStageName,
    job: JobRow,
    llmCalls: TraceLlmCall[],
    scope: TraceStageScope,
  ): TraceStage {
    const status = mapJobStatus(job.status);
    const startedAt = job.started_at;
    const completedAt = job.completed_at;
    const durationMs =
      startedAt && completedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
        : null;

    return {
      stage: stageName,
      scope,
      status,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      output: truncateOutput(job.result),
      error_reason: job.error ?? null,
      llm_calls: llmCalls,
    };
  }

  // Loads every llm_calls row tagged with this memory_id and groups
  // them by stage. The trace endpoint then attaches the matching list
  // under stage.llm_calls. response_text is truncated to a smaller
  // display cap (5KB) so the JSON payload stays bounded — the
  // recorder already stored a larger version in the DB if anyone
  // needs the full body via the llm_calls query API.
  private async loadLlmCallsByStage(
    memoryId: string,
  ): Promise<Map<string, TraceLlmCall[]>> {
    const result = await this.db.execute(sql`
      select
        id::text as id,
        provider,
        model,
        stage,
        prompt_messages,
        response_text,
        response_metadata,
        prompt_tokens,
        completion_tokens,
        latency_ms,
        status,
        error_reason,
        truncated,
        created_at::text as created_at
      from llm_calls
      where memory_id = ${memoryId}::uuid
      order by created_at asc
    `);
    const rows = result.rows as Array<{
      id: string;
      provider: string;
      model: string;
      stage: string;
      prompt_messages: unknown;
      response_text: string | null;
      response_metadata: unknown;
      prompt_tokens: number | string;
      completion_tokens: number | string;
      latency_ms: number | string;
      status: string;
      error_reason: string | null;
      truncated: boolean | null;
      created_at: string;
    }>;
    const grouped = new Map<string, TraceLlmCall[]>();
    for (const row of rows) {
      const stageName =
        this.normalizeStage(row.stage) ??
        STAGE_FROM_JOB_KIND[row.stage] ??
        null;
      if (!stageName) continue;
      const list = grouped.get(stageName) ?? [];
      list.push({
        id: row.id,
        provider: row.provider,
        model: row.model,
        prompt_messages: normalizePromptMessages(row.prompt_messages),
        response_text: truncateResponseText(row.response_text),
        response_metadata: normalizeMetadata(row.response_metadata),
        prompt_tokens: Number(row.prompt_tokens),
        completion_tokens: Number(row.completion_tokens),
        latency_ms: Number(row.latency_ms),
        status: row.status,
        error_reason: row.error_reason,
        truncated: row.truncated === true,
        created_at: row.created_at,
      });
      grouped.set(stageName, list);
    }
    return grouped;
  }

  private computeTiming(jobs: JobRow[]): {
    total_ms: number | null;
    started_at: string | null;
    completed_at: string | null;
  } {
    if (jobs.length === 0) {
      return { total_ms: null, started_at: null, completed_at: null };
    }
    const startTimes = jobs
      .map((job) => job.started_at)
      .filter((value): value is string => !!value)
      .map((value) => Date.parse(value))
      .filter((parsed) => Number.isFinite(parsed));
    const endTimes = jobs
      .map((job) => job.completed_at)
      .filter((value): value is string => !!value)
      .map((value) => Date.parse(value))
      .filter((parsed) => Number.isFinite(parsed));

    if (startTimes.length === 0 || endTimes.length === 0) {
      return { total_ms: null, started_at: null, completed_at: null };
    }
    const startMs = Math.min(...startTimes);
    const endMs = Math.max(...endTimes);
    return {
      total_ms: Math.max(0, endMs - startMs),
      started_at: new Date(startMs).toISOString(),
      completed_at: new Date(endMs).toISOString(),
    };
  }
}

interface JobRow {
  id: string;
  kind: string | null;
  stage: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  result: unknown;
  error: string | null;
}

function mapJobStatus(raw: string | null): TraceStageStatus {
  switch (raw) {
    case "done":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    case "running":
      return "running";
    default:
      return "pending";
  }
}

function previewText(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(/\s+/g, " ").slice(0, 200);
}

function truncateOutput(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= RESULT_PAYLOAD_MAX_CHARS) return value;
    return {
      _truncated: true,
      preview: serialized.slice(0, RESULT_PAYLOAD_MAX_CHARS),
    };
  } catch {
    return null;
  }
}

// Drizzle returns jsonb columns as already-parsed values when the
// driver decodes them, but raw queries may surface them as strings.
// Normalize both shapes — the trace endpoint needs a real array/object
// in its response payload.
function normalizePromptMessages(
  raw: unknown,
): Array<{ role: string; content: string }> | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(value)) return null;
  const out: Array<{ role: string; content: string }> = [];
  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const role = (entry as Record<string, unknown>).role;
      const content = (entry as Record<string, unknown>).content;
      if (typeof role === "string" && typeof content === "string") {
        out.push({ role, content });
      }
    }
  }
  return out.length > 0 ? out : null;
}

function normalizeMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Min/max bounds across the memory-scoped jobs, used to find
// project-scoped stages that fired during the same window. Falls back
// to the memory's own created_at when no started_at/completed_at are
// available yet (jobs queued but not yet run).
function computeJobWindow(
  jobs: JobRow[],
  memoryCreatedAt: string,
): { startMs: number; endMs: number } {
  const candidates: number[] = [];
  const fallback = Date.parse(memoryCreatedAt);
  if (Number.isFinite(fallback)) candidates.push(fallback);
  for (const job of jobs) {
    for (const value of [job.started_at, job.completed_at, job.created_at]) {
      if (!value) continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) candidates.push(parsed);
    }
  }
  if (candidates.length === 0) {
    return { startMs: Number.NaN, endMs: Number.NaN };
  }
  return {
    startMs: Math.min(...candidates),
    endMs: Math.max(...candidates),
  };
}

function truncateResponseText(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw.length <= TRACE_RESPONSE_DISPLAY_MAX_CHARS) return raw;
  return `${raw.slice(0, TRACE_RESPONSE_DISPLAY_MAX_CHARS)}…[truncated]`;
}
