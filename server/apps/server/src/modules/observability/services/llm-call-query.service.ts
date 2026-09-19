import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { requireProjectAccess } from "@openkt/auth-authorization";
import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError, UnauthorizedDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import type {
  LlmCallListQuery,
  LlmCallRow,
  UsageBucketRow,
  UsageQuery,
} from "../contracts/observability.contract";

@Injectable()
export class LlmCallQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Paginated list of llm_calls rows. The visibility rules are simple:
  //  - if project_id is supplied, the actor must have project read access
  //  - else the result is scoped to the actor's own user_id only
  // This mirrors the same shape as the existing invocations endpoint
  // and avoids leaking cross-tenant rows when a misconfigured client
  // forgets a project filter.
  async listLlmCalls(
    context: ActorContext,
    query: LlmCallListQuery,
  ): Promise<{ items: LlmCallRow[]; next_cursor: string | null }> {
    const actorUserId = context.principal.userId;
    if (!actorUserId && !query.project_id) {
      throw new UnauthorizedDomainError("user principal required");
    }
    if (query.project_id) {
      await requireProjectAccess(context, query.project_id, "read");
    }

    const cursorDate = parseCursor(query.cursor);

    const result = await this.db.execute(sql`
      select id, project_id, user_id, provider, model, stage, purpose,
             memory_id, episode_id, prompt_tokens, completion_tokens,
             total_tokens, cost_usd, latency_ms, status, error_reason,
             request_id, created_at
      from llm_calls
      where (${query.project_id ?? null}::uuid is null or project_id = ${query.project_id ?? null}::uuid)
        and (${query.user_id ?? null}::uuid is null or user_id = ${query.user_id ?? null}::uuid)
        and (${query.provider ?? null}::text is null or provider = ${query.provider ?? null}::text)
        and (${query.stage ?? null}::text is null or stage = ${query.stage ?? null}::text)
        and (${query.status ?? null}::text is null or status = ${query.status ?? null}::text)
        and (${query.since ?? null}::timestamptz is null or created_at >= ${query.since ?? null}::timestamptz)
        and (${query.until ?? null}::timestamptz is null or created_at <= ${query.until ?? null}::timestamptz)
        and (${cursorDate ?? null}::timestamptz is null or created_at < ${cursorDate ?? null}::timestamptz)
        and (
          ${query.project_id ?? null}::uuid is not null
          or user_id = ${actorUserId ?? null}::uuid
        )
      order by created_at desc
      limit ${query.limit + 1}
    `);

    const rows = result.rows.map(rowToLlmCallRow);
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1]?.created_at ?? null : null;
    return { items, next_cursor: nextCursor };
  }

  // Usage rollups, grouped by day / hour / provider / stage.
  async usage(context: ActorContext, query: UsageQuery): Promise<UsageBucketRow[]> {
    const actorUserId = context.principal.userId;
    if (!actorUserId && !query.project_id) {
      throw new UnauthorizedDomainError("user principal required");
    }
    if (query.project_id) {
      await requireProjectAccess(context, query.project_id, "read");
    }
    if (query.user_id && query.user_id !== actorUserId && !query.project_id) {
      throw new ForbiddenDomainError("cannot query another user's usage without a project scope");
    }

    const bucketExpr =
      query.group_by === "hour"
        ? sql`date_trunc('hour', created_at)::text`
        : query.group_by === "day"
          ? sql`date_trunc('day', created_at)::text`
          : query.group_by === "provider"
            ? sql`'all'::text`
            : sql`'all'::text`;
    const providerExpr =
      query.group_by === "stage" ? sql`'all'::text` : sql`provider`;
    const stageExpr =
      query.group_by === "stage" ? sql`stage` : sql`null::text`;

    const result = await this.db.execute(sql`
      select ${bucketExpr} as bucket,
             ${providerExpr} as provider,
             ${stageExpr} as stage,
             coalesce(sum(prompt_tokens), 0)::bigint as total_prompt_tokens,
             coalesce(sum(completion_tokens), 0)::bigint as total_completion_tokens,
             coalesce(sum(total_tokens), 0)::bigint as total_tokens,
             coalesce(sum(cost_usd), 0)::numeric as total_cost_usd,
             count(*)::bigint as call_count
      from llm_calls
      where (${query.project_id ?? null}::uuid is null or project_id = ${query.project_id ?? null}::uuid)
        and (${query.user_id ?? null}::uuid is null or user_id = ${query.user_id ?? null}::uuid)
        and (${query.provider ?? null}::text is null or provider = ${query.provider ?? null}::text)
        and (${query.since ?? null}::timestamptz is null or created_at >= ${query.since ?? null}::timestamptz)
        and (${query.until ?? null}::timestamptz is null or created_at <= ${query.until ?? null}::timestamptz)
        and (
          ${query.project_id ?? null}::uuid is not null
          or user_id = ${actorUserId ?? null}::uuid
        )
      group by 1, 2, 3
      order by 1 desc
      limit 1000
    `);

    return result.rows.map(
      (row): UsageBucketRow => ({
        bucket: String(row.bucket ?? ""),
        provider: String(row.provider ?? "all"),
        stage: row.stage == null ? null : String(row.stage),
        total_prompt_tokens: Number(row.total_prompt_tokens ?? 0),
        total_completion_tokens: Number(row.total_completion_tokens ?? 0),
        total_tokens: Number(row.total_tokens ?? 0),
        total_cost_usd: Number(row.total_cost_usd ?? 0),
        call_count: Number(row.call_count ?? 0),
      }),
    );
  }
}

function rowToLlmCallRow(row: Record<string, unknown>): LlmCallRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string | null) ?? null,
    user_id: (row.user_id as string | null) ?? null,
    provider: row.provider as string,
    model: row.model as string,
    stage: row.stage as string,
    purpose: (row.purpose as string | null) ?? null,
    memory_id: (row.memory_id as string | null) ?? null,
    episode_id: (row.episode_id as string | null) ?? null,
    prompt_tokens: Number(row.prompt_tokens ?? 0),
    completion_tokens: Number(row.completion_tokens ?? 0),
    total_tokens: Number(row.total_tokens ?? 0),
    cost_usd: String(row.cost_usd ?? "0"),
    latency_ms: Number(row.latency_ms ?? 0),
    status: row.status as string,
    error_reason: (row.error_reason as string | null) ?? null,
    request_id: (row.request_id as string | null) ?? null,
    created_at: new Date(row.created_at as string).toISOString(),
  };
}

function parseCursor(cursor?: string | null): string | null {
  if (!cursor) return null;
  const t = Date.parse(cursor);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
