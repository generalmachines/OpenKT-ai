import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError } from "@openkt/core-errors";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { PersonalTokensService } from "../services/personal-tokens.service";

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(z.enum(["read", "write", "admin"])).optional(),
  expires_in_days: z.number().int().positive().max(365).optional(),
});

// Personal Access Tokens — `/v1/me/tokens`. The `me` namespace makes it
// clear the auth principal is the implicit subject; admins managing
// other users' tokens isn't a supported flow.
//
// Tokens are issued from a Supabase-authed session (dashboard). Once
// issued, the raw token can be used as `Authorization: Bearer okt_pat_…`
// against any /v1/* endpoint AND the MCP server. Only the hash is
// stored; the raw token is shown exactly once.
@Controller("me/tokens")
@UseGuards(SupabaseJwtGuard)
@ApiBearerAuth("supabase-bearer")
@ApiTags("Personal Access Tokens")
export class PersonalTokensController {
  constructor(private readonly tokens: PersonalTokensService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Create a personal access token. Returns the raw `okt_pat_…` value " +
      "in `token` — copy it now, you won't see it again.",
  })
  async create(
    @ActorContextParam() actor: ActorContext,
    @Body() body: unknown,
  ) {
    const userId = requireUserId(actor);
    const input = parseWithSchema(CreateBody, body);
    const expiresAt = input.expires_in_days
      ? new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000)
      : null;
    const issued = await this.tokens.create({
      userId,
      name: input.name,
      scopes: input.scopes,
      expiresAt,
    });
    return okResponse({
      id: issued.id,
      name: issued.name,
      scopes: issued.scopes,
      prefix: issued.prefix,
      token: issued.rawToken,
      created_at: issued.createdAt,
      expires_at: issued.expiresAt,
    });
  }

  @Get()
  @ApiOperation({ summary: "List the caller's active tokens (no secrets)." })
  async list(@ActorContextParam() actor: ActorContext) {
    const userId = requireUserId(actor);
    const rows = await this.tokens.list(userId);
    return okResponse({
      count: rows.length,
      tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        prefix: t.prefix,
        created_at: t.createdAt,
        last_used_at: t.lastUsedAt,
        expires_at: t.expiresAt,
      })),
    });
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a token. Irreversible." })
  async revoke(
    @ActorContextParam() actor: ActorContext,
    @Param("id") id: string,
  ) {
    const userId = requireUserId(actor);
    await this.tokens.revoke(userId, id);
    return okResponse({ revoked: true });
  }
}

function requireUserId(actor: ActorContext): string {
  if (actor.principal.type !== "user" || !actor.principal.userId) {
    throw new ForbiddenDomainError("user principal required");
  }
  return actor.principal.userId;
}
