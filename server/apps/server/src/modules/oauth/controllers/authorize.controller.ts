import { Controller, Get, HttpException, HttpStatus, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { z } from "zod";

import { parseWithSchema } from "../../../common/http/zod-parse";
import { OauthError, OauthService } from "../services/oauth.service";

// GET /oauth/authorize is the RFC 6749 §4.1.1 authorization endpoint.
// We don't run any auth at this layer: the dashboard is the surface
// that actually signs the user in (Supabase) and shows the "Allow
// Claude.ai?" UX. This controller's job is to:
//   1) sanity-check the incoming params (client exists, redirect_uri
//      matches, S256 PKCE, response_type=code)
//   2) bounce the browser to `${OPENKT_DASHBOARD_URL}/oauth/authorize?…`
//      with all params forwarded plus the resolved client_name for the
//      consent screen
//
// ────── CONTRACT WITH THE DASHBOARD FRONTEND ──────────────────────────
//
// Bounce target: `${OPENKT_DASHBOARD_URL}/oauth/authorize`
//
// Query params forwarded (URL-encoded):
//   client_id       — opaque, ready to POST back to /oauth/consent
//   client_name     — human-readable, render in the consent UI
//   redirect_uri    — exact registered URI, do not let the user edit
//   state           — opaque, forward verbatim to /oauth/consent
//   code_challenge  — opaque, forward verbatim
//   code_challenge_method (always "S256" today)
//   scope           — optional, default "read write"
//   response_type   — always "code"
//
// After the user signs in via Supabase the dashboard MUST POST to:
//
//   POST /oauth/consent
//   Authorization: Bearer <supabase JWT>
//   Content-Type: application/json
//   {
//     "client_id":             "<same>",
//     "redirect_uri":          "<same>",
//     "state":                 "<same>",
//     "code_challenge":        "<same>",
//     "code_challenge_method": "S256",
//     "scope":                 "read write"   // optional
//   }
//
// Response: { data: { redirect_url: "<redirect_uri>?code=…&state=…" } }
// The dashboard then navigates window.location to redirect_url so the
// browser pops back into Claude.ai with the auth code.
//
// "Auto-allow" UX: the chosen default is to skip the explicit Allow
// button — once the user has a Supabase session and is on
// /oauth/authorize, the dashboard immediately POSTs and redirects.
// Flip to an explicit click by deferring the POST behind a button if
// we later need an audit trail of explicit consent events.

const AuthorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().default("S256"),
  scope: z.string().optional(),
});

@Controller("oauth")
@ApiTags("OAuth (Claude.ai / DCR clients)")
export class OauthAuthorizeController {
  constructor(
    private readonly oauth: OauthService,
    private readonly config: ConfigService,
  ) {}

  @Get("authorize")
  @ApiOperation({
    summary: "RFC 6749 §4.1.1 authorization endpoint",
    description:
      "Claude.ai opens this in a popup. We validate params + 302 to " +
      "${OPENKT_DASHBOARD_URL}/oauth/authorize?... where the dashboard " +
      "handles Supabase sign-in + consent. The dashboard then POSTs to " +
      "/oauth/consent. Bad client_id / redirect_uri → 400 inline; other " +
      "errors → redirect back to redirect_uri with ?error=... per spec.",
  })
  @ApiQuery({ name: "response_type", required: true, example: "code" })
  @ApiQuery({ name: "client_id", required: true, example: "okt_oauth_<64hex>" })
  @ApiQuery({ name: "redirect_uri", required: true })
  @ApiQuery({ name: "code_challenge", required: true, description: "base64url S256, >= 43 chars" })
  @ApiQuery({ name: "code_challenge_method", required: true, example: "S256" })
  @ApiQuery({ name: "state", required: false })
  @ApiQuery({ name: "scope", required: false, example: "read write" })
  @ApiResponse({ status: 302, description: "Redirect to dashboard consent page" })
  @ApiResponse({ status: 400, description: "invalid_client | invalid_redirect_uri" })
  async authorize(
    @Query() query: unknown,
    @Req() _req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const input = parseWithSchema(AuthorizeQuery, query);

    let client;
    try {
      client = await this.oauth.loadAuthorizeRequest({
        clientId: input.client_id,
        redirectUri: input.redirect_uri,
        responseType: input.response_type,
        codeChallenge: input.code_challenge,
        codeChallengeMethod: input.code_challenge_method,
      });
    } catch (error) {
      if (error instanceof OauthError) {
        // Per RFC 6749 §4.1.2.1, if redirect_uri or client_id are bad
        // we must NOT redirect — surface the error inline so the user
        // sees what went wrong rather than being thrown to a random
        // redirect target.
        if (
          error.oauthCode === "invalid_client" ||
          error.oauthCode === "invalid_redirect_uri"
        ) {
          throw new HttpException(
            { error: error.oauthCode, error_description: error.message },
            HttpStatus.BAD_REQUEST,
          );
        }
        // For other errors (bad response_type, bad PKCE method) the
        // redirect_uri IS validated, so we can bounce the error back to
        // the client per §4.1.2.1.
        const url = new URL(input.redirect_uri);
        url.searchParams.set("error", error.oauthCode);
        url.searchParams.set("error_description", error.message);
        if (input.state) url.searchParams.set("state", input.state);
        res.redirect(302, url.toString());
        return;
      }
      throw error;
    }

    const dashboardBase = (
      this.config.get<string>("OPENKT_DASHBOARD_URL") ??
      "http://localhost:3000"
    ).replace(/\/+$/, "");
    const target = new URL(`${dashboardBase}/oauth/authorize`);
    target.searchParams.set("client_id", client.clientId);
    target.searchParams.set("client_name", client.name);
    target.searchParams.set("redirect_uri", input.redirect_uri);
    if (input.state) target.searchParams.set("state", input.state);
    target.searchParams.set("code_challenge", input.code_challenge);
    target.searchParams.set("code_challenge_method", input.code_challenge_method);
    if (input.scope) target.searchParams.set("scope", input.scope);
    target.searchParams.set("response_type", input.response_type);

    res.redirect(302, target.toString());
  }
}
