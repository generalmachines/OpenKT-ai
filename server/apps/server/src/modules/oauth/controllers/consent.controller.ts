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
import { BearerAuthGuard } from "../../auth/guards/bearer-auth.guard";
import { OauthError, OauthService } from "../services/oauth.service";

// POST /oauth/consent — for a frontend that signs the person in itself
// (a dashboard, the desktop app) instead of using the server's own sign-in
// page at GET /oauth/authorize. It POSTs the original authorize params with
// the person's bearer — an `okt_pat_…` session token from /v1/auth/login, or
// a Supabase JWT when Supabase is configured — and gets back the URL to send
// the browser to:
//
//   POST /oauth/consent   Authorization: Bearer <token>
//   { client_id, redirect_uri, state?, code_challenge, code_challenge_method: "S256", scope? }
//   → { data: { redirect_url: "<redirect_uri>?code=…&state=…" } }

const ConsentBody = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().default("S256"),
  scope: z.string().optional(),
});

@Controller("oauth")
@UseGuards(BearerAuthGuard)
@ApiBearerAuth("supabase-bearer")
@ApiTags("OAuth (Claude.ai / DCR clients)")
export class OauthConsentController {
  constructor(private readonly oauth: OauthService) {}

  @Post("consent")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mint an OAuth auth code for a frontend that signed the person in itself",
    description:
      "Optional alternative to the server-rendered page at GET /oauth/authorize. " +
      "POST the original authorize params with the person's bearer (okt_pat_ session " +
      "token, or a Supabase JWT when Supabase is configured). Validates the client + " +
      "PKCE challenge, issues a one-shot auth code and returns the redirect URL.",
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
