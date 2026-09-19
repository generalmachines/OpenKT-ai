import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { NotFoundDomainError } from "@openkt/core-errors";

import { okResponse } from "../../../common/http/ok-response";
import type { RequestWithContext } from "../../../common/http/request-with-context";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { RequireOrgRole } from "../guards/require-org-role.decorator";
import { RequireOrgRoleGuard } from "../guards/require-org-role.guard";
import { InvitesApplicationService } from "../services/invites-application.service";
import type { ActorContext } from "@openkt/core-context";

// Snake-case at the wire, camelCase internally.
const CreateInviteSchema = z
  .object({
    org_slug: z.string().min(1).max(64),
    email: z.string().email().nullable().optional(),
    role: z.enum(["owner", "admin", "member"]).default("member"),
    max_uses: z.number().int().positive().max(10_000).nullable().optional(),
    expires_in_days: z.number().int().positive().max(365).default(14),
    is_open: z.boolean().optional(),
  })
  .transform((value) => ({
    orgSlug: value.org_slug,
    email: value.email ?? null,
    role: value.role,
    maxUses: value.max_uses ?? null,
    expiresInDays: value.expires_in_days,
    isOpen: value.is_open ?? false,
  }));

const ListInvitesQuerySchema = z
  .object({ org_slug: z.string().min(1).max(64) })
  .transform((v) => ({ orgSlug: v.org_slug }));

const InviteIdParamSchema = z.object({ id: z.string().uuid() });
const TokenParamSchema = z.object({
  token: z
    .string()
    .min(8)
    .max(128)
    .regex(/^inv_[A-Za-z0-9_-]{8,}$/, "malformed invite token"),
});
const AcceptInviteSchema = z.object({
  token: z
    .string()
    .min(8)
    .max(128)
    .regex(/^inv_[A-Za-z0-9_-]{8,}$/, "malformed invite token"),
});

@Controller("invites")
@ApiTags("Invites")
@ApiBearerAuth("supabase-bearer")
export class InvitesController {
  constructor(private readonly invitesApplicationService: InvitesApplicationService) {}

  @Post()
  @UseGuards(SupabaseJwtGuard, RequireOrgRoleGuard)
  @RequireOrgRole("admin")
  @ApiOperation({ summary: "Create an org invite (targeted or open link)" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        org_slug: { type: "string", maxLength: 64 },
        email: { type: "string", format: "email", nullable: true },
        role: { type: "string", enum: ["owner", "admin", "member"], default: "member" },
        max_uses: { type: "integer", nullable: true, minimum: 1, maximum: 10000 },
        expires_in_days: { type: "integer", minimum: 1, maximum: 365, default: 14 },
        is_open: { type: "boolean" },
      },
      required: ["org_slug"],
    },
  })
  async create(
    @ActorContextParam() context: ActorContext,
    @Req() request: RequestWithContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(CreateInviteSchema, body);
    const callerRole =
      (request as RequestWithContext & { resolvedOrgRole?: string }).resolvedOrgRole ?? null;
    const created = await this.invitesApplicationService.create(context, input, callerRole);
    return okResponse({
      invite_id: created.inviteId,
      invite_url: created.inviteUrl,
      token: created.token,
      mode: created.mode,
      expires_at: created.expiresAt,
      role: created.role,
      max_uses: created.maxUses,
    });
  }

  @Get()
  @UseGuards(SupabaseJwtGuard, RequireOrgRoleGuard)
  @RequireOrgRole("member")
  @ApiOperation({ summary: "List pending org invites" })
  @ApiQuery({ name: "org_slug", required: true, schema: { type: "string", maxLength: 64 } })
  async list(
    @ActorContextParam() context: ActorContext,
    @Query() query: unknown,
  ) {
    const { orgSlug } = parseWithSchema(ListInvitesQuerySchema, query);
    const invites = await this.invitesApplicationService.list(context, orgSlug);
    return okResponse(
      invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        mode: i.mode,
        expires_at: i.expiresAt,
        max_uses: i.maxUses,
        used_count: i.usedCount,
        created_at: i.createdAt,
        invite_url: i.inviteUrl,
      })),
    );
  }

  @Delete(":id")
  @UseGuards(SupabaseJwtGuard, RequireOrgRoleGuard)
  @RequireOrgRole("admin")
  @HttpCode(204)
  @ApiOperation({ summary: "Revoke an org invite" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  async revoke(
    @ActorContextParam() context: ActorContext,
    @Param() params: unknown,
  ) {
    const { id } = parseWithSchema(InviteIdParamSchema, params);
    await this.invitesApplicationService.revoke(context, id);
    return okResponse({ id, revoked: true });
  }

  // Public preview — used by the dashboard's /invite/[token] page to
  // render the org name + role before sign-in. Intentionally not
  // behind SupabaseJwtGuard.
  @Get("preview/:token")
  @ApiOperation({ summary: "Public preview of an invite by token" })
  @ApiParam({ name: "token", schema: { type: "string", maxLength: 128 } })
  async preview(@Param() params: unknown) {
    const { token } = parseWithSchema(TokenParamSchema, params);
    const preview = await this.invitesApplicationService.preview(token);
    if (!preview) throw new NotFoundDomainError("invite");
    return okResponse({
      org_id: preview.orgId,
      org_name: preview.orgName,
      role: preview.role,
      invited_by_name: preview.invitedByName,
      mode: preview.mode,
      expires_at: preview.expiresAt,
      remaining_uses: preview.remainingUses,
    });
  }

  @Post("accept")
  @UseGuards(SupabaseJwtGuard)
  @ApiOperation({ summary: "Accept an invite token" })
  @ApiBody({
    schema: {
      type: "object",
      properties: { token: { type: "string", minLength: 8, maxLength: 128 } },
      required: ["token"],
    },
  })
  async accept(
    @ActorContextParam() context: ActorContext,
    @Body() body: unknown,
  ) {
    const input = parseWithSchema(AcceptInviteSchema, body);
    const outcome = await this.invitesApplicationService.accept(context, input.token);
    return okResponse({
      org_id: outcome.orgId,
      org_slug: outcome.orgSlug,
      role: outcome.role,
    });
  }
}
