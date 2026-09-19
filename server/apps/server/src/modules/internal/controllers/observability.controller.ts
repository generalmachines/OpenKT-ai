import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { sql } from "drizzle-orm";

import { okResponse } from "../../../common/http/ok-response";
import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// /v1/internal/observability/* — read-only endpoints that surface the
// state of the async pipeline so you can watch a memory move through
// preprocess → embed → triage → episode → briefing without opening a
// psql session. Mounted under /internal/* and intentionally NOT
// guarded yet — for local dev. Production deployments should put this
// behind ServicePrincipalGuard or a network ACL.

@Controller("internal/observability")
@ApiTags("Internal Observability")
export class ObservabilityController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
  ) {}

  @Get("pipeline")
  @ApiOperation({
    summary: "Recent worker pipeline activity (agentic_jobs + outbox + brief stats)",
    description:
      "Returns the last N agentic_jobs rows with their stage, status, result, and the matching memory + project IDs. Useful for watching the pipeline live in dev.",
  })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } })
  @ApiQuery({ name: "project_id", required: false, schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "memory_id", required: false, schema: { type: "string", format: "uuid" } })
  async pipeline(
    @Query("limit") limitRaw?: string,
    @Query("project_id") projectId?: string,
    @Query("memory_id") memoryId?: string,
  ) {
    const limit = clamp(parseInt(limitRaw ?? "50", 10) || 50, 1, 200);
    const where = sql`true`;
    const filters = [];
    if (projectId) filters.push(sql`project_id = ${projectId}::uuid`);
    if (memoryId) filters.push(sql`memory_id = ${memoryId}::uuid`);
    const whereClause =
      filters.length > 0 ? sql`${where} and ${sql.join(filters, sql` and `)}` : where;

    const jobs = await this.db.execute(sql`
      select
        id,
        stage,
        status,
        attempts,
        memory_id,
        project_id,
        org_id,
        version_token,
        result,
        error,
        started_at,
        completed_at,
        created_at
      from agentic_jobs
      where ${whereClause}
      order by created_at desc
      limit ${limit}
    `);

    const stats = await this.db.execute(sql`
      select stage, status, count(*)::int as n
      from agentic_jobs
      where created_at > now() - interval '15 minutes'
      group by stage, status
      order by stage, status
    `);

    const outbox = await this.db.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where published_at is null)::int as unpublished,
        count(*) filter (where last_error is not null)::int as with_errors,
        max(attempts) as max_attempts
      from outbox_events
      where created_at > now() - interval '1 hour'
    `);

    return okResponse({
      window_minutes: 15,
      stats: stats.rows,
      outbox_recent: outbox.rows[0] ?? {},
      jobs: jobs.rows,
    });
  }

  @Get("memories/:id/timeline")
  @ApiOperation({
    summary: "Per-memory timeline: pipeline jobs + recall accesses for one memory",
  })
  async memoryTimeline(@Query("id") memoryId: string) {
    const jobs = await this.db.execute(sql`
      select stage, status, attempts, result, error, started_at, completed_at, created_at
      from agentic_jobs
      where memory_id = ${memoryId}::uuid
      order by created_at asc
    `);
    const accesses = await this.db.execute(sql`
      select action, surface, actor_user_id, invocation_id, at
      from memory_accesses
      where memory_id = ${memoryId}::uuid
      order by at asc
    `);
    const refs = await this.db.execute(sql`
      select provider, external_kind, external_id, external_namespace, external_project_id, created_at, updated_at
      from memory_external_refs
      where memory_id = ${memoryId}::uuid
    `);
    return okResponse({
      memory_id: memoryId,
      external_refs: refs.rows,
      pipeline_jobs: jobs.rows,
      access_log: accesses.rows,
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
