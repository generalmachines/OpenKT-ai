import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireMemoryReadAccess, requireProjectAccess } from "@openkt/auth-authorization";
import type { ActorContext } from "@openkt/core-context";
import { NotFoundDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../db/drizzle.module";

const UUID = z.string().uuid();
const Status = z.enum(["ok", "error", "timeout", "cancelled"]);
const SummaryInput = z.object({
  project_id: UUID.optional(),
  since_hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});
const ListInvocationsInput = SummaryInput.extend({
  user_id: UUID.optional(),
  tool_name: z.string().max(120).optional(),
  tool: z.string().max(120).optional(),
  caller: z.string().max(120).optional(),
  status: Status.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const MemoryActivityInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Injectable()
export class ObservabilityService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async summary(context: ActorContext, raw: unknown) {
    const input = SummaryInput.parse(raw);
    await this.ensureProject(context, input.project_id);
    const rows = await this.invocationRows(context, input);
    const todaySince = new Date(Date.now() - 24 * 3600_000).toISOString();
    const durations = rows
      .map((row) => row.duration_ms)
      .filter((value): value is number => typeof value === "number" && value >= 0)
      .sort((a, b) => a - b);
    return {
      tools: new Set(rows.map((row) => row.tool_name)).size,
      composio_tools: 0,
      agents: new Set(rows.map((row) => row.agent_identity).filter(Boolean)).size,
      invocations: {
        total: rows.length,
        today: rows.filter((row) => row.invoked_at >= todaySince).length,
        errors: rows.filter((row) => row.status === "error").length,
        last_call: rows[0]?.invoked_at ?? null,
      },
      total_invocations: rows.length,
      ok: rows.filter((row) => row.status === "ok").length,
      error: rows.filter((row) => row.status === "error").length,
      timeout: rows.filter((row) => row.status === "timeout").length,
      cancelled: rows.filter((row) => row.status === "cancelled").length,
      avg_duration_ms: avg(durations),
      p95_duration_ms: percentile(durations, 0.95),
      unique_tools: new Set(rows.map((row) => row.tool_name)).size,
      unique_callers: new Set(rows.map((row) => row.user_id).filter(Boolean)).size,
      unique_projects: new Set(rows.map((row) => row.project_id).filter(Boolean)).size,
    };
  }

  async tools(context: ActorContext, raw: unknown) {
    const input = SummaryInput.parse(raw);
    await this.ensureProject(context, input.project_id);
    const rows = await this.invocationRows(context, input);
    const byTool = groupBy(rows, (row) => row.tool_name);
    const metrics = Array.from(byTool.entries()).map(([toolName, calls]) => {
      const durations = calls
        .map((row) => row.duration_ms)
        .filter((value): value is number => typeof value === "number" && value >= 0)
        .sort((a, b) => a - b);
      return {
        tool_name: toolName,
        total: calls.length,
        today: calls.filter((row) => Date.now() - new Date(row.invoked_at).getTime() < 24 * 3600_000).length,
        ok: calls.filter((row) => row.status === "ok").length,
        err: calls.filter((row) => row.status === "error").length,
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95),
        last_call: calls[0]?.invoked_at ?? null,
      };
    }).sort((a, b) => b.total - a.total);

    return {
      catalog: metrics.map((metric) => ({
        tool_name: metric.tool_name,
        category: "openkt",
        description: null,
        input_schema: null,
        output_schema: null,
        verdict: metric.err > 0 ? "warn" : "ok",
        verdict_note: null,
        audited_at: null,
      })),
      metrics,
    };
  }

  async toolDetail(context: ActorContext, name: string, raw: unknown) {
    const input = SummaryInput.parse(raw);
    await this.ensureProject(context, input.project_id);
    const rows = (await this.invocationRows(context, input))
      .filter((row) => row.tool_name === name)
      .slice(0, 25);
    const durations = rows
      .map((row) => row.duration_ms)
      .filter((value): value is number => typeof value === "number" && value >= 0)
      .sort((a, b) => a - b);
    return {
      rollup: {
        tool_name: name,
        category: "openkt",
        calls: rows.length,
        errors: rows.filter((row) => row.status === "error").length,
        avg_duration_ms: avg(durations),
        last_invoked_at: rows[0]?.invoked_at ?? null,
      },
      recent: rows,
      catalog: null,
    };
  }

  async invocations(context: ActorContext, raw: unknown) {
    const input = ListInvocationsInput.parse(raw);
    await this.ensureProject(context, input.project_id);
    return (await this.invocationRows(context, input)).slice(0, input.limit);
  }

  async invocation(context: ActorContext, id: string) {
    UUID.parse(id);
    const rows = await this.db.execute(sql`
      select *
      from tool_invocations
      where id = ${id}::uuid
      limit 1
    `);
    const row = rows.rows[0] as unknown as InvocationRow | undefined;
    if (!row) throw new NotFoundDomainError("invocation");
    if (row.project_id) await requireProjectAccess(context, row.project_id, "read");
    else if (row.user_id && row.user_id !== context.principal.userId) throw new NotFoundDomainError("invocation");
    return {
      ...row,
      memory_refs: [],
      skill_refs: [],
    };
  }

  async memoryActivity(context: ActorContext, id: string, raw: unknown) {
    UUID.parse(id);
    const input = MemoryActivityInput.parse(raw);
    await requireMemoryReadAccess(context, id);
    const rows = await this.db.execute(sql`
      select id, memory_id, actor_user_id, action, surface, invocation_id, at
      from memory_accesses
      where memory_id = ${id}::uuid
      order by at desc
      limit ${input.limit}
    `);
    return rows.rows.map((row) => ({
      access_id: row.id,
      memory_id: row.memory_id,
      actor_user_id: row.actor_user_id,
      action: row.action,
      surface: row.surface,
      invocation_id: row.invocation_id,
      created_at: row.at,
    }));
  }

  private async ensureProject(context: ActorContext, projectId?: string): Promise<void> {
    if (projectId) await requireProjectAccess(context, projectId, "read");
  }

  private async invocationRows(
    context: ActorContext,
    input: { project_id?: string; since_hours: number; tool_name?: string; tool?: string; status?: string; user_id?: string; caller?: string },
  ): Promise<InvocationRow[]> {
    const since = new Date(Date.now() - input.since_hours * 3600_000).toISOString();
    const toolName = input.tool_name ?? input.tool;
    const actorUserId = context.principal.userId;
    const userFilter = input.user_id ?? input.caller;
    const rows = await this.db.execute(sql`
      select id, org_id, project_id, user_id, tool_name, status, duration_ms,
             session_id, agent_identity, invoked_at, args, result_summary, error_message
      from tool_invocations
      where invoked_at >= ${since}::timestamptz
        and (${input.project_id ?? null}::uuid is null or project_id = ${input.project_id ?? null}::uuid)
        and (${toolName ?? null}::text is null or tool_name = ${toolName ?? null})
        and (${input.status ?? null}::text is null or status = ${input.status ?? null})
        and (${userFilter ?? null}::uuid is null or user_id = ${userFilter ?? null}::uuid)
        and (
          ${input.project_id ?? null}::uuid is not null
          or user_id = ${actorUserId ?? null}::uuid
        )
      order by invoked_at desc
      limit 500
    `);
    return rows.rows as unknown as InvocationRow[];
  }
}

interface InvocationRow {
  id: string;
  org_id: string | null;
  project_id: string | null;
  user_id: string | null;
  tool_name: string;
  status: "ok" | "error" | "timeout" | "cancelled";
  duration_ms: number | null;
  session_id: string | null;
  agent_identity: string | null;
  invoked_at: string;
  args?: unknown;
  result_summary?: unknown;
  error_message?: string | null;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key) ?? [];
    existing.push(item);
    map.set(key, existing);
  }
  return map;
}
