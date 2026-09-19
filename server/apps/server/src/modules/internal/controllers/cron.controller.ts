import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiExcludeController } from "@nestjs/swagger";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { memories } from "../../../db/schema";

// POST /v1/internal/cron/archive-stale — archives stale memories in OpenKT Postgres.
//
// Auth = shared-secret header (CRON_SECRET) so an external scheduler
// (Vercel Cron, EventBridge, App Runner schedule, plain `curl` from a
// host cron) can run it without minting a Supabase JWT. Two locks:
// env equality here; guessing the URL does not help.
//
// Mirrors the legacy /api/cron/archive-stale shape so existing
// scheduler entries keep working after the prefix flip.
//
// Idempotent — re-running mid-day is fine: the predicate
// (`archived = false`) skips already-swept rows.

// Body is optional; the controller passes `{}` when none was sent.
// .strict() keeps surprise keys out so a misconfigured scheduler that
// posts `{op:"…"}` gets a clear 400.
const ArchiveBodySchema = z
  .object({
    scope_org_id: z.string().uuid().nullable().optional(),
    max_rows: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

type ArchiveRow = {
  archived_id: string;
  org_id: string;
  project_id: string;
};

@Controller("internal/cron")
@ApiExcludeController()
export class CronController {
  constructor(
    private readonly configService: ConfigService,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  @Post("archive-stale")
  @HttpCode(HttpStatus.OK)
  async archiveStale(
    @Headers("authorization") authHeader: string | undefined,
    @Headers("x-cron-secret") cronHeader: string | undefined,
    @Body() body: unknown,
  ) {
    // Fail closed on missing config — an unconfigured deployment must
    // never become an open archive trigger.
    const expected = this.configService.get<string>("CRON_SECRET");
    if (!expected) {
      throw new ServiceUnavailableException(
        "CRON_SECRET is not configured on this deployment",
      );
    }

    const bearer = (authHeader ?? "").toLowerCase().startsWith("bearer ")
      ? (authHeader ?? "").slice(7).trim()
      : "";
    const token = bearer || (cronHeader ?? "");
    if (token !== expected) {
      throw new ForbiddenException("invalid or missing cron secret");
    }

    const input = parseWithSchema(ArchiveBodySchema, body ?? {});
    const started = Date.now();
    const maxRows = input.max_rows ?? 1000;
    const scopeOrgId = input.scope_org_id ?? null;
    const rows = await this.archiveStaleMemories(scopeOrgId, maxRows);
    return okResponse({
      archived_count: rows.length,
      archived_ids: rows.map((r) => r.archived_id),
      scope_org_id: scopeOrgId,
      duration_ms: Date.now() - started,
    });
  }

  private async archiveStaleMemories(
    scopeOrgId: string | null,
    maxRows: number,
  ): Promise<ArchiveRow[]> {
    const rows = await this.db.execute(sql<ArchiveRow>`
      with candidates as (
        select ${memories.id} as id
        from ${memories}
        where ${memories.archived} = false
          and ${memories.isPinned} = false
          and (${scopeOrgId}::uuid is null or ${memories.orgId} = ${scopeOrgId}::uuid)
          and (
            ${memories.confidence} <= 0.05
            or (
              ${memories.importance} <= 0.1
              and ${memories.updatedAt} < now() - interval '180 days'
              and ${memories.lastRecallAt} is null
            )
          )
        order by ${memories.updatedAt} asc
        limit ${maxRows}
      )
      update ${memories}
      set archived = true, updated_at = now()
      from candidates
      where ${memories.id} = candidates.id
      returning
        ${memories.id}::text as archived_id,
        ${memories.orgId}::text as org_id,
        ${memories.projectId}::text as project_id
    `);

    return rows.rows.map((row) => ({
      archived_id: String(row.archived_id),
      org_id: String(row.org_id),
      project_id: String(row.project_id),
    }));
  }
}
