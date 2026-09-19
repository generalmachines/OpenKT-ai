import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RequireOrgRole } from "../../invites/guards/require-org-role.decorator";
import { RequireOrgRoleGuard } from "../../invites/guards/require-org-role.guard";
import {
  AuditListQuerySchema,
  AuditOrgParamSchema,
} from "../contracts/audit.contract";
import { AuditQueryService } from "../services/audit-query.service";

// /v1/audit/* — read-only surface over the append-only audit_log table.
// Admin (or owner) of the target org is required; writes happen
// in-band with the originating action and are never accepted over HTTP.
@Controller("audit")
@ApiTags("Audit")
@ApiBearerAuth("supabase-bearer")
export class AuditController {
  constructor(private readonly auditQueryService: AuditQueryService) {}

  @Get("orgs/:orgId")
  @UseGuards(SupabaseJwtGuard, RequireOrgRoleGuard)
  @RequireOrgRole("admin")
  @ApiOperation({ summary: "List audit-log entries for an org (admin only)" })
  @ApiParam({ name: "orgId", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "actor_id", required: false, schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "action", required: false, schema: { type: "string", maxLength: 128 } })
  @ApiQuery({ name: "resource_type", required: false, schema: { type: "string", maxLength: 64 } })
  @ApiQuery({ name: "resource_id", required: false, schema: { type: "string", maxLength: 256 } })
  @ApiQuery({ name: "since", required: false, schema: { type: "string", format: "date-time" } })
  @ApiQuery({ name: "until", required: false, schema: { type: "string", format: "date-time" } })
  @ApiQuery({ name: "cursor", required: false, schema: { type: "string", format: "date-time" } })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } })
  async listForOrg(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<unknown> {
    // The route param key is `orgId` to match the guard's `params.orgId`
    // resolution path; the contract accepts `org_id` so we re-key
    // before parsing.
    const raw = (params as Record<string, unknown>) ?? {};
    const { org_id } = parseWithSchema(AuditOrgParamSchema, { org_id: raw.orgId });
    const parsed = parseWithSchema(AuditListQuerySchema, query ?? {});
    return okResponse(await this.auditQueryService.listForOrg(org_id, parsed));
  }
}
