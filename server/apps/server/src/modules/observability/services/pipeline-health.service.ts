import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

export interface PipelineHealthSnapshot {
  stage_status_counts: Array<{
    stage: string;
    status: string;
    count: number;
  }>;
  recent_failures: Array<{
    id: string;
    stage: string | null;
    kind: string;
    error: string | null;
    last_error_at: string | null;
    created_at: string;
    project_id: string | null;
    org_id: string | null;
    user_id: string | null;
  }>;
  median_latency_ms_by_stage: Array<{
    stage: string;
    median_ms: number | null;
    sample_count: number;
  }>;
  generated_at: string;
}

@Injectable()
export class PipelineHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async snapshot(context: ActorContext): Promise<PipelineHealthSnapshot> {
    const userId = context.principal.userId;
    if (!userId) {
      throw new UnauthorizedDomainError("user principal required");
    }

    // Scope health metrics to the actor's own work so personal-tier
    // users still see useful numbers; org/admin dashboards filter on
    // project_id at the endpoint layer.
    const statusRes = await this.db.execute(sql`
      select coalesce(stage, kind) as stage, status, count(*)::bigint as count
      from agentic_jobs
      where user_id = ${userId}::uuid
      group by coalesce(stage, kind), status
      order by stage, status
    `);

    const failuresRes = await this.db.execute(sql`
      select id, stage, kind, error, last_error_at, created_at,
             project_id, org_id, user_id
      from agentic_jobs
      where status = 'failed' and user_id = ${userId}::uuid
      order by coalesce(last_error_at, created_at) desc
      limit 10
    `);

    const latencyRes = await this.db.execute(sql`
      select coalesce(stage, kind) as stage,
             percentile_cont(0.5) within group (
               order by extract(epoch from (completed_at - started_at)) * 1000
             ) as median_ms,
             count(*)::bigint as sample_count
      from agentic_jobs
      where completed_at is not null
        and started_at is not null
        and completed_at >= now() - interval '1 hour'
        and user_id = ${userId}::uuid
      group by coalesce(stage, kind)
    `);

    return {
      stage_status_counts: statusRes.rows.map((row) => ({
        stage: String(row.stage ?? "unknown"),
        status: String(row.status ?? "unknown"),
        count: Number(row.count ?? 0),
      })),
      recent_failures: failuresRes.rows.map((row) => ({
        id: row.id as string,
        stage: (row.stage as string | null) ?? null,
        kind: row.kind as string,
        error: (row.error as string | null) ?? null,
        last_error_at:
          row.last_error_at == null
            ? null
            : new Date(row.last_error_at as string).toISOString(),
        created_at: new Date(row.created_at as string).toISOString(),
        project_id: (row.project_id as string | null) ?? null,
        org_id: (row.org_id as string | null) ?? null,
        user_id: (row.user_id as string | null) ?? null,
      })),
      median_latency_ms_by_stage: latencyRes.rows.map((row) => ({
        stage: String(row.stage ?? "unknown"),
        median_ms: row.median_ms == null ? null : Number(row.median_ms),
        sample_count: Number(row.sample_count ?? 0),
      })),
      generated_at: new Date().toISOString(),
    };
  }
}
