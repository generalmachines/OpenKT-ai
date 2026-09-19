import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { parseWithSchema } from "../../../common/http/zod-parse";
import { OauthError, OauthService } from "../services/oauth.service";

// POST /oauth/token — RFC 6749 §3.2 / §4.1.3 + §6.
//
// We accept two grant types:
//
//   1. authorization_code
//      body: grant_type, code, redirect_uri, client_id, code_verifier
//            [+ client_secret for confidential clients]
//      Validates PKCE (S256 by default) + client credentials (secret for
//      confidential clients, PKCE verifier for public clients) + code
//      freshness, marks the code used, mints an access + refresh token
//      pair.
//
//   2. refresh_token
//      body: grant_type, refresh_token, client_id
//            [+ client_secret for confidential clients]
//      Validates the refresh token + client credentials, rotates the
//      pair (old refresh + access are both revoked, new ones minted).
//
// Public clients (registered with token_endpoint_auth_method = "none")
// omit client_secret entirely — they use PKCE as proof of possession.
// Confidential clients (client_secret_post) must supply client_secret.
//
// Successful response (§5.1):
//   { access_token, token_type: "Bearer", expires_in, refresh_token, scope }
//
// Error response (§5.2):
//   { error: "...", error_description: "..." }  status 400
//
// No global v1 prefix here — Claude.ai discovers the endpoint via
// /.well-known/oauth-authorization-server which returns the absolute
// URL.

const TokenBody = z.union([
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    redirect_uri: z.string().url(),
    client_id: z.string().min(1),
    // Optional: required for confidential clients, forbidden for public
    // clients per RFC 6749 §4.1.3 / OAuth 2.1 §4.1.3.
    client_secret: z.string().min(1).optional(),
    code_verifier: z.string().min(43).max(128),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
    // Optional: same confidential/public split.
    client_secret: z.string().min(1).optional(),
  }),
]);

@Controller("oauth")
@ApiTags("OAuth (Claude.ai / DCR clients)")
export class OauthTokenController {
  constructor(private readonly oauth: OauthService) {}

  @Post("token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "RFC 6749 token endpoint (authorization_code + refresh_token grants)",
    description:
      "POST grant_type=authorization_code with code + code_verifier (PKCE " +
      "S256) + client_id + client_secret + redirect_uri to exchange a fresh " +
      "auth code for an access token (90d TTL, okt_pat_ prefix) and refresh " +
      "token. POST grant_type=refresh_token with refresh_token + client " +
      "credentials to rotate. Success shape per §5.1, errors per §5.2.",
  })
  @ApiResponse({
    status: 200,
    description: "Access + refresh tokens",
    schema: {
      type: "object",
      properties: {
        access_token: { type: "string", example: "okt_pat_<64hex>" },
        token_type: { type: "string", example: "Bearer" },
        expires_in: { type: "number", example: 7776000 },
        refresh_token: { type: "string", example: "okt_rt_<64hex>" },
        scope: { type: "string", example: "read write" },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "invalid_request | invalid_client | invalid_grant (RFC 6749 §5.2)",
  })
  async token(
    @Body() body: unknown,
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // RFC 6749 §5.1: token responses (and errors) must not be cached.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    let input: z.infer<typeof TokenBody>;
    try {
      input = parseWithSchema(TokenBody, withBasicCredentials(body, authorization));
    } catch {
      // Zod failure → RFC 6749 §5.2 invalid_request.
      throw new HttpException(
        {
          error: "invalid_request",
          error_description: "missing or malformed parameters",
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      if (input.grant_type === "authorization_code") {
        const pair = await this.oauth.exchangeAuthorizationCode({
          code: input.code,
          clientId: input.client_id,
          // Undefined for public clients — assertClientCredentials will
          // skip the secret check when the client is registered as "none".
          clientSecret: input.client_secret ?? null,
          redirectUri: input.redirect_uri,
          codeVerifier: input.code_verifier,
        });
        return {
          access_token: pair.accessToken,
          token_type: "Bearer",
          expires_in: pair.expiresInSec,
          refresh_token: pair.refreshToken,
          scope: pair.scopes.join(" "),
        };
      }
      const pair = await this.oauth.refreshTokens({
        refreshToken: input.refresh_token,
        clientId: input.client_id,
        clientSecret: input.client_secret ?? null,
      });
      return {
        access_token: pair.accessToken,
        token_type: "Bearer",
        expires_in: pair.expiresInSec,
        refresh_token: pair.refreshToken,
        scope: pair.scopes.join(" "),
      };
    } catch (error) {
      if (error instanceof OauthError) {
        const status =
          error.oauthCode === "invalid_client"
            ? HttpStatus.UNAUTHORIZED
            : HttpStatus.BAD_REQUEST;
        throw new HttpException(
          {
            error: error.oauthCode,
            error_description: error.message,
          },
          status,
        );
      }
      throw error;
    }
  }
}

// client_secret_basic (RFC 6749 §2.3.1): `Authorization: Basic
// base64(urlencode(client_id) ":" urlencode(client_secret))`. The credentials
// are folded into the body so one code path checks them; a client_id in the
// body must agree with the header.
export function withBasicCredentials(body: unknown, authorization: string | undefined): unknown {
  const match = authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!match || typeof body !== "object" || body === null) return body;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return body;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return body;
  const safeDecode = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return v;
    }
  };
  const clientId = safeDecode(decoded.slice(0, i));
  const clientSecret = safeDecode(decoded.slice(i + 1));
  const fields = body as Record<string, unknown>;
  if (typeof fields.client_id === "string" && fields.client_id !== clientId) {
    throw new HttpException(
      { error: "invalid_client", error_description: "client_id in the body does not match HTTP Basic" },
      HttpStatus.UNAUTHORIZED,
    );
  }
  return { ...fields, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
}
