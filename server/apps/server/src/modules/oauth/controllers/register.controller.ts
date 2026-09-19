import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { RateLimit } from "../../rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../rate-limit/guards/rate-limit.guard";
import { OauthError, OauthService } from "../services/oauth.service";

// RFC 7591 — Dynamic Client Registration.
//
// No auth required at the protocol level; the IP-scoped rate limit
// (5/min) is what stops this from becoming a token foundry. We also
// reject non-https redirect_uris (except http://localhost for native
// dev) and cap the client name length at the service layer.
//
// Response shape mirrors RFC 7591 §3.2.1 so Claude.ai parses without
// extra adapter code.

// Accepted values for token_endpoint_auth_method.
// "none" → public client (PKCE-only, no secret issued).
// "client_secret_post" (default) / "client_secret_basic" → confidential client;
// the secret comes in the token request body or in HTTP Basic.
// Anything else is refused with RFC 7591's invalid_client_metadata.
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

const RegisterBody = z.object({
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  token_endpoint_auth_method: z.string().max(100).optional(),
});

@Controller("oauth")
@ApiTags("OAuth (Claude.ai / DCR clients)")
export class OauthRegisterController {
  constructor(private readonly oauth: OauthService) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit({
    key: "ip",
    name: "oauth_register",
    // Every claude.ai (or ChatGPT) user registers from the same few backend
    // addresses, and they register again on each reconnect: 5/min would turn
    // one busy minute into "could not connect" for everyone. 60/min still
    // stops a registration flood.
    capacity: 60,
    refillPerSec: 1, // 60/min
  })
  @ApiOperation({
    summary: "RFC 7591 dynamic client registration",
    description:
      "MCP clients (Claude.ai) POST here to auto-mint a client_id + " +
      "client_secret. No auth required at the protocol level — rate-limited " +
      "to 5/min/IP. Response is RFC 7591 §3.2.1 shape (no /v1 envelope).",
  })
  @ApiResponse({
    status: 201,
    description: "Client registered. SAVE THE SECRET — it's only returned once.",
    schema: {
      type: "object",
      properties: {
        client_id: { type: "string", example: "okt_oauth_<64hex>" },
        client_secret: { type: "string", example: "<64hex>" },
        client_id_issued_at: { type: "number" },
        client_name: { type: "string" },
        redirect_uris: { type: "array", items: { type: "string" } },
        grant_types: { type: "array", items: { type: "string" } },
        response_types: { type: "array", items: { type: "string" } },
        token_endpoint_auth_method: { type: "string", example: "client_secret_post" },
      },
    },
  })
  async register(@Body() body: unknown) {
    const parsed = RegisterBody.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { error: "invalid_client_metadata", error_description: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        HttpStatus.BAD_REQUEST,
      );
    }
    const input = parsed.data;
    const requested = input.token_endpoint_auth_method ?? "client_secret_post";
    if (!(AUTH_METHODS as readonly string[]).includes(requested)) {
      throw new HttpException(
        { error: "invalid_client_metadata", error_description: `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    const authMethod = requested as (typeof AUTH_METHODS)[number];
    try {
      const client = await this.oauth.register({
        clientName: input.client_name,
        redirectUris: input.redirect_uris,
        tokenEndpointAuthMethod: authMethod,
      });
      // RFC 7591 §3.2.1 — top-level fields, no envelope.
      // Public clients: omit client_secret from the response (RFC 7591
      // §3.2.1 says the secret MUST NOT be included when the method is
      // "none").
      const response: Record<string, unknown> = {
        client_id: client.clientId,
        client_id_issued_at: client.clientIdIssuedAt,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      };
      if (client.clientSecret !== undefined) {
        response.client_secret = client.clientSecret;
        // RFC 7591 §3.2.1: REQUIRED when a secret is issued; 0 = never expires.
        response.client_secret_expires_at = 0;
      }
      if (input.scope) response.scope = input.scope;
      return response;
    } catch (error) {
      if (error instanceof OauthError) {
        // RFC 7591 §3.2.2 error payload shape.
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
