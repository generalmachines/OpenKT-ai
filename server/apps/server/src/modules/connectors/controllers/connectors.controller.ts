import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError } from "@openkt/core-errors";

import type { Request } from "express";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { ConnectorsService } from "../services/connectors.service";

const Query_ = z.object({
  client: z.string().min(1).max(64).optional(),
});

// /v1/me/connectors — returns pre-formatted install configs for every
// supported MCP client (Claude.ai, Claude Code, Cursor, VS Code,
// Codex) with a fresh PAT baked in. The dashboard renders one button
// per client; click → user is connected in seconds.
//
// Auth: Supabase JWT only. We don't accept PAT here because the whole
// point is to mint a NEW PAT for the connector — a PAT minting a PAT
// is a recursion footgun and reduces revocation hygiene.
@Controller("me/connectors")
@UseGuards(SupabaseJwtGuard)
@ApiBearerAuth("supabase-bearer")
@ApiTags("Connectors")
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  @ApiOperation({
    summary:
      "Generate install configs for every supported MCP client. Mints a fresh " +
      "PAT named after the calling client (`client` query param) so the user " +
      "can revoke that connector independently.",
  })
  async build(
    @ActorContextParam() actor: ActorContext,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    if (actor.principal.type !== "user" || !actor.principal.userId) {
      throw new ForbiddenDomainError("user principal required");
    }
    const { client } = parseWithSchema(Query_, query);
    const baseUrl = resolveBaseUrl(req);
    const bundle = await this.connectors.build({
      userId: actor.principal.userId,
      tokenName: client ? `connector:${client}` : "connector:quick-install",
      baseUrl,
    });
    return okResponse(bundle);
  }
}

function resolveBaseUrl(req: Request): string {
  // Honour Cloudflare / ALB headers so we don't return http:// links
  // when the public origin is https://. Fallback to the raw host.
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ??
    (req.protocol || "http");
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host");
  return `${proto}://${host}`;
}
