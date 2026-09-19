import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { requireProjectAccess } from "@openkt/auth-authorization";
import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// Per-project "live pipeline" firehose. Three tables, one chronological
// stream:
//
//   - agentic_jobs    → kind = "stage"
//   - llm_calls       → kind = "llm_call"
//   - outbox_events   → kind = "outbox"
//
// They're UNION ALL'd in a single SQL pass and ordered by their
// effective timestamp DESC. The cursor is a `(timestamp, kind, id)`
// tuple encoded as a string so callers can paginate without skipping
// rows when several events share the same millisecond.
//
// The UI polls this for its live view, so we keep the payload bounded:
// prompt_messages → up to 5KB serialized; response_text → 5KB; outbox
// payloads → no embedding (the outbox row + event_type + claim
// metadata are enough for the live tile).

export type PipelineEventKind = "stage" | "llm_call" | "outbox";

export interface PipelineEvent {
  kind: PipelineEventKind;
  timestamp: string;
  event: Record<string, unknown>;
}

export interface PipelineStreamResponse {
  events: PipelineEvent[];
  cursor: string | null;
  stats: { stages: number; llm_calls: number; outbox: number };
}

export interface PipelineStreamQuery {
  project_id: string;
  since?: string;
  limit: number;
  cursor?: string;
}

// Display-side caps. Recorder may have stored up to 64KB; we truncate
// to 5KB here so a 100-event poll stays well under a few hundred KB.
const FIELD_DISPLAY_MAX_CHARS = 5_000;

interface RawUnionRow {
  kind: PipelineEventKind;
  id: string;
  ts: string;
  // Stage columns
  stage_kind: string | null;
  stage_name: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  payload: unknown;
  result: unknown;
  error: string | null;
  // llm_calls columns
  provider: string | null;
  model: string | null;
  llm_stage: string | null;
  prompt_messages: unknown;
  response_text: string | null;
  response_metadata: unknown;
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
  total_tokens: number | string | null;
  cost_usd: string | null;
  latency_ms: number | string | null;
  llm_status: string | null;
  error_reason: string | null;
  memory_id: string | null;
  episode_id: string | null;
  // outbox columns
  event_type: string | null;
  aggregate_id: string | null;
  aggregate_type: string | null;
  attempts: number | string | null;
  last_error: string | null;
  claimed_at: string | null;
  published_at: string | null;
}

@Injectable()
export class PipelineStreamService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async stream(
    context: ActorContext,
    query: PipelineStreamQuery,
  ): Promise<PipelineStreamResponse> {
    await requireProjectAccess(context, query.project_id, "read");

    const cursor = decodeCursor(query.cursor);
    const cursorTs = cursor?.timestamp ?? null;
    const cursorKind = cursor?.kind ?? null;
    const cursorId = cursor?.id ?? null;
    const sinceIso = query.since ?? null;

    // Each branch of the UNION exposes the same column list so the
    // outer query can ORDER BY a single timestamp column. Columns that
    // don't apply to a branch are NULL.
    //
    // We over-fetch by 1 row to detect "has more" without an extra
    // round trip. Cursor pagination compares (ts, kind, id) lexically
    // to break ties when many rows share a millisecond.
    const result = await this.db.execute(sql`
      with
        stage_events as (
          select
            'stage'::text as kind,
            id::text as id,
            coalesce(completed_at, started_at, created_at) as ts,
            kind as stage_kind,
            stage as stage_name,
            status,
            started_at::text as started_at,
            completed_at::text as completed_at,
            payload,
            result,
            error,
            null::text as provider,
            null::text as model,
            null::text as llm_stage,
            null::jsonb as prompt_messages,
            null::text as response_text,
            null::jsonb as response_metadata,
            null::bigint as prompt_tokens,
            null::bigint as completion_tokens,
            null::bigint as total_tokens,
            null::text as cost_usd,
            null::bigint as latency_ms,
            null::text as llm_status,
            null::text as error_reason,
            memory_id::text as memory_id,
            null::text as episode_id,
            null::text as event_type,
            null::text as aggregate_id,
            null::text as aggregate_type,
            null::bigint as attempts,
            null::text as last_error,
            null::text as claimed_at,
            null::text as published_at
          from agentic_jobs
          where project_id = ${query.project_id}::uuid
        ),
        llm_events as (
          select
            'llm_call'::text as kind,
            id::text as id,
            created_at as ts,
            null::text as stage_kind,
            null::text as stage_name,
            null::text as status,
            null::text as started_at,
            null::text as completed_at,
            null::jsonb as payload,
            null::jsonb as result,
            null::text as error,
            provider,
            model,
            stage as llm_stage,
            prompt_messages,
            response_text,
            response_metadata,
            prompt_tokens::bigint as prompt_tokens,
            completion_tokens::bigint as completion_tokens,
            total_tokens::bigint as total_tokens,
            cost_usd::text as cost_usd,
            latency_ms::bigint as latency_ms,
            status as llm_status,
            error_reason,
            memory_id::text as memory_id,
            episode_id::text as episode_id,
            null::text as event_type,
            null::text as aggregate_id,
            null::text as aggregate_type,
            null::bigint as attempts,
            null::text as last_error,
            null::text as claimed_at,
            null::text as published_at
          from llm_calls
          where project_id = ${query.project_id}::uuid
        ),
        outbox_pevents as (
          -- outbox_events isn't keyed by project_id directly; we join
          -- via aggregate_type='memory' → memories.project_id. This is
          -- a cheap indexed join on memories.id (the outbox stores the
          -- memory uuid as aggregate_id). Non-memory aggregates are
          -- excluded today; if more aggregate types ship later we can
          -- left-join through their own owner tables.
          select
            'outbox'::text as kind,
            o.id::text as id,
            coalesce(o.claimed_at, o.published_at, o.created_at) as ts,
            null::text as stage_kind,
            null::text as stage_name,
            null::text as status,
            null::text as started_at,
            null::text as completed_at,
            null::jsonb as payload,
            null::jsonb as result,
            null::text as error,
            null::text as provider,
            null::text as model,
            null::text as llm_stage,
            null::jsonb as prompt_messages,
            null::text as response_text,
            null::jsonb as response_metadata,
            null::bigint as prompt_tokens,
            null::bigint as completion_tokens,
            null::bigint as total_tokens,
            null::text as cost_usd,
            null::bigint as latency_ms,
            null::text as llm_status,
            null::text as error_reason,
            o.aggregate_id::text as memory_id,
            null::text as episode_id,
            o.event_type,
            o.aggregate_id::text as aggregate_id,
            o.aggregate_type,
            o.attempts::bigint as attempts,
            o.last_error,
            o.claimed_at::text as claimed_at,
            o.published_at::text as published_at
          from outbox_events o
          join memories m on m.id = o.aggregate_id
          where o.aggregate_type = 'memory'
            and m.project_id = ${query.project_id}::uuid
        ),
        unioned as (
          select * from stage_events
          union all
          select * from llm_events
          union all
          select * from outbox_pevents
        )
      select
        kind, id, ts::text as ts,
        stage_kind, stage_name, status, started_at, completed_at,
        payload, result, error,
        provider, model, llm_stage, prompt_messages, response_text,
        response_metadata, prompt_tokens, completion_tokens,
        total_tokens, cost_usd, latency_ms, llm_status, error_reason,
        memory_id, episode_id,
        event_type, aggregate_id, aggregate_type, attempts,
        last_error, claimed_at, published_at
      from unioned
      where ts is not null
        and (${sinceIso}::timestamptz is null or ts >= ${sinceIso}::timestamptz)
        and (
          ${cursorTs}::timestamptz is null
          or ts < ${cursorTs}::timestamptz
          or (ts = ${cursorTs}::timestamptz and (
            kind > ${cursorKind ?? ""}::text
            or (kind = ${cursorKind ?? ""}::text and id > ${cursorId ?? ""}::text)
          ))
        )
      order by ts desc, kind asc, id asc
      limit ${query.limit + 1}
    `);

    const rows = (result.rows as unknown as RawUnionRow[]).map(normalizeRow);
    const hasMore = rows.length > query.limit;
    const trimmed = hasMore ? rows.slice(0, query.limit) : rows;
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ timestamp: last.timestamp, kind: last.kind, id: extractId(last) })
        : null;

    const stats = trimmed.reduce(
      (acc, ev) => {
        if (ev.kind === "stage") acc.stages += 1;
        else if (ev.kind === "llm_call") acc.llm_calls += 1;
        else if (ev.kind === "outbox") acc.outbox += 1;
        return acc;
      },
      { stages: 0, llm_calls: 0, outbox: 0 },
    );

    return { events: trimmed, cursor: nextCursor, stats };
  }
}

function normalizeRow(row: RawUnionRow): PipelineEvent {
  const timestamp = toIsoString(row.ts) ?? row.ts;
  if (row.kind === "stage") {
    return {
      kind: "stage",
      timestamp,
      event: {
        id: row.id,
        kind: row.stage_kind,
        stage: row.stage_name,
        status: row.status,
        started_at: toIsoString(row.started_at),
        completed_at: toIsoString(row.completed_at),
        memory_id: row.memory_id,
        payload: truncateJson(row.payload),
        result: truncateJson(row.result),
        error: row.error,
      },
    };
  }
  if (row.kind === "llm_call") {
    return {
      kind: "llm_call",
      timestamp,
      event: {
        id: row.id,
        provider: row.provider,
        model: row.model,
        stage: row.llm_stage,
        prompt_messages: truncatePrompt(row.prompt_messages),
        response_text: truncateString(row.response_text),
        response_metadata: row.response_metadata ?? null,
        prompt_tokens: numericOrNull(row.prompt_tokens),
        completion_tokens: numericOrNull(row.completion_tokens),
        total_tokens: numericOrNull(row.total_tokens),
        cost_usd: row.cost_usd,
        latency_ms: numericOrNull(row.latency_ms),
        status: row.llm_status,
        error_reason: row.error_reason,
        memory_id: row.memory_id,
        episode_id: row.episode_id,
      },
    };
  }
  // outbox
  return {
    kind: "outbox",
    timestamp,
    event: {
      id: row.id,
      event_type: row.event_type,
      aggregate_id: row.aggregate_id,
      aggregate_type: row.aggregate_type,
      attempts: numericOrNull(row.attempts),
      last_error: row.last_error,
      claimed_at: toIsoString(row.claimed_at),
      published_at: toIsoString(row.published_at),
    },
  };
}

function extractId(ev: PipelineEvent): string {
  const raw = (ev.event as { id?: unknown }).id;
  return typeof raw === "string" ? raw : "";
}

function toIsoString(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Date(parsed).toISOString();
}

function numericOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truncateString(raw: string | null): string | null {
  if (!raw) return raw ?? null;
  if (raw.length <= FIELD_DISPLAY_MAX_CHARS) return raw;
  return `${raw.slice(0, FIELD_DISPLAY_MAX_CHARS)}…[truncated]`;
}

function truncateJson(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized.length <= FIELD_DISPLAY_MAX_CHARS) return raw;
    return {
      _truncated: true,
      preview: serialized.slice(0, FIELD_DISPLAY_MAX_CHARS),
    };
  } catch {
    return null;
  }
}

function truncatePrompt(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  // prompt_messages is jsonb; we serialize once, then cap the entire
  // payload at FIELD_DISPLAY_MAX_CHARS rather than per-message so a
  // single huge user message still triggers truncation.
  try {
    const serialized = JSON.stringify(raw);
    if (serialized.length <= FIELD_DISPLAY_MAX_CHARS) return raw;
    return {
      _truncated: true,
      preview: serialized.slice(0, FIELD_DISPLAY_MAX_CHARS),
    };
  } catch {
    return null;
  }
}

// Cursor encoding: timestamp|kind|id concatenated and base64'd. We use
// "|" as the separator because none of the three fields contain it
// (timestamps are ISO, kind is one of three enum strings, id is uuid
// or short hex).
interface CursorTuple {
  timestamp: string;
  kind: string;
  id: string;
}

function encodeCursor(c: CursorTuple): string {
  return Buffer.from(`${c.timestamp}|${c.kind}|${c.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): CursorTuple | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parts = decoded.split("|");
    if (parts.length !== 3) return null;
    const [timestamp, kind, id] = parts;
    if (!timestamp || !kind || !id) return null;
    return { timestamp, kind, id };
  } catch {
    return null;
  }
}
