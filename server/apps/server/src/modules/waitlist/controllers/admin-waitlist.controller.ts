import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError } from "@openkt/core-errors";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { PlatformAdminGuard } from "../../analytics/guards/platform-admin.guard";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { WaitlistService } from "../services/waitlist.service";

const StatusQuery = z.object({
  status: z.enum(["pending", "approved", "all"]).default("pending"),
});

const DenyBody = z.object({
  reason: z.string().max(500).optional(),
});

@Controller("internal/waitlist")
@ApiTags("Internal Waitlist (admin)")
@UseGuards(SupabaseJwtGuard, PlatformAdminGuard)
@ApiBearerAuth("supabase-bearer")
export class AdminWaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Get()
  @ApiOperation({ summary: "List waitlist rows (pending|approved|all)" })
  async list(@Query() query: unknown) {
    const { status } = parseWithSchema(StatusQuery, query);
    const rows =
      status === "approved"
        ? await this.waitlist.listApproved()
        : status === "all"
          ? await this.waitlist.listAll()
          : await this.waitlist.listPending();
    return okResponse({
      status,
      count: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        email: r.email,
        source: r.source,
        note: r.note,
        use_case: r.useCase,
        referrer: r.referrer,
        requested_at: r.requestedAt,
        approved_at: r.approvedAt,
        approved_by: r.approvedBy,
        denied_at: r.deniedAt,
        denied_reason: r.deniedReason,
        signed_up_at: r.signedUpAt,
      })),
    });
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Approve a waitlist row for beta signup" })
  async approve(
    @Param("id") id: string,
    @ActorContextParam() actor: ActorContext,
  ) {
    if (actor.principal.type !== "user" || !actor.principal.userId) {
      throw new ForbiddenDomainError("user principal required");
    }
    const row = await this.waitlist.approve(id, actor.principal.userId);
    return okResponse({
      id: row.id,
      email: row.email,
      approved_at: row.approvedAt,
      approved_by: row.approvedBy,
    });
  }

  @Post(":id/deny")
  @ApiOperation({ summary: "Deny a waitlist row" })
  async deny(@Param("id") id: string, @Body() body: unknown) {
    const { reason } = parseWithSchema(DenyBody, body ?? {});
    const row = await this.waitlist.deny(id, reason ?? null);
    return okResponse({
      id: row.id,
      email: row.email,
      denied_at: row.deniedAt,
      denied_reason: row.deniedReason,
    });
  }
}
