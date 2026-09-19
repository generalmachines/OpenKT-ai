import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError } from "@openkt/core-errors";

import { okResponse } from "../../../common/http/ok-response";
import { parseWithSchema } from "../../../common/http/zod-parse";
import { ActorContextParam } from "../../auth/decorators/actor-context.decorator";
import { SupabaseJwtGuard } from "../../auth/guards/supabase-jwt.guard";
import { OauthError, OauthService } from "../services/oauth.service";

// POST /oauth/consent — called by the dashboard frontend after the user
// signs in (Supabase) and (optionally) clicks Allow on the consent
// screen. Mints the authorization code and returns the redirect URL the
// dashboard should navigate the popup to so the OAuth client picks the
// code up.
//
// See the contract docstring at the top of `authorize.controller.ts`
// for the exact payload + response shape.

const ConsentBody = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().default("S256"),
  scope: z.string().optional(),
});

@Controller("oauth")
@UseGuards(SupabaseJwtGuard)
@ApiBearerAuth("supabase-bearer")
@ApiTags("OAuth (Claude.ai / DCR clients)")
export class OauthConsentController {
  constructor(private readonly oauth: OauthService) {}

  @Post("consent")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mint an OAuth auth code (called by dashboard /oauth/authorize page)",
    description:
      "After the dashboard signs the user in and gets consent, it POSTs " +
      "the original authorize params back here with a Supabase JWT. We " +
      "validate the client + PKCE challenge, then issue a one-shot auth " +
      "code and return the redirect URL the dashboard should navigate the " +
      "popup to. Frontend should be the only caller — Claude.ai itself " +
      "never hits this directly.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["client_id", "redirect_uri", "code_challenge"],
      properties: {
        client_id: { type: "string" },
        redirect_uri: { type: "string", format: "uri" },
        state: { type: "string" },
        code_challenge: { type: "string" },
        code_challenge_method: { type: "string", example: "S256" },
        scope: { type: "string", example: "read write" },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "Auth code minted; navigate window to redirect_url",
    schema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            redirect_url: {
              type: "string",
              example: "https://claude.ai/oauth/callback?code=<x>&state=<y>",
            },
          },
        },
        error: { type: "null" },
        meta: { type: "null" },
      },
    },
  })
  async consent(
    @ActorContextParam() actor: ActorContext,
    @Body() body: unknown,
  ) {
    if (actor.principal.type !== "user" || !actor.principal.userId) {
      throw new ForbiddenDomainError("user principal required");
    }
    const userId = actor.principal.userId;
    const input = parseWithSchema(ConsentBody, body);

    try {
      const scopes = input.scope
        ? input.scope.split(/\s+/).filter(Boolean)
        : undefined;
      const { code } = await this.oauth.mintAuthorizationCode({
        userId,
        clientId: input.client_id,
        redirectUri: input.redirect_uri,
        codeChallenge: input.code_challenge,
        codeChallengeMethod: input.code_challenge_method,
        scopes,
      });

      const redirect = new URL(input.redirect_uri);
      redirect.searchParams.set("code", code);
      if (input.state) redirect.searchParams.set("state", input.state);

      return okResponse({ redirect_url: redirect.toString() });
    } catch (error) {
      if (error instanceof OauthError) {
        throw new HttpException(
          {
            error: error.oauthCode,
            error_description: error.message,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw error;
    }
  }
}
