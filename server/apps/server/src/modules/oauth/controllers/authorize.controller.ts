import { Body, Controller, Get, HttpException, Post, Query, Req, Res } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { z } from "zod";

import { mapRequestMetadata } from "@openkt/auth-principal";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { AccountsService, type SignedInUser } from "../../accounts/services/accounts.service";
import { MAX_PASSWORD_LENGTH } from "../../accounts/services/password-policy";
import {
  FORM_COOKIE_NAME,
  FORM_TOKEN_TTL_SEC,
  OauthFormTokenService,
  type AuthorizeParams,
} from "../services/oauth-form-token.service";
import { OauthError, OauthService, type OauthClientRecord } from "../services/oauth.service";
import { renderErrorPage, renderSignInPage, type RenderedPage, type SignInMode } from "../views/sign-in-page";

// /oauth/authorize — the RFC 6749 §4.1.1 authorization endpoint, with the
// sign-in and consent screen served by this server. No dashboard is involved:
//
//   GET  /oauth/authorize?response_type=code&client_id=…&redirect_uri=…
//        &code_challenge=…&code_challenge_method=S256[&state][&scope][&resource]
//        → validates the client and redirect_uri, then renders the sign-in page
//          (email + password, a "Create an account" toggle, Allow / Cancel).
//   POST /oauth/authorize   (application/x-www-form-urlencoded, from that page)
//        → checks the CSRF form token, signs in (or signs up) through
//          AccountsService — the same scrypt, attempt limits and errors as
//          /v1/auth/login and /v1/auth/signup — mints an authorization code
//          and 302s to redirect_uri?code=…&state=….
//
// Per RFC 6749 §4.1.2.1: an unknown client or an unregistered redirect_uri is
// shown as an error page and never redirected; any other problem with a
// verified redirect_uri goes back to the client as ?error=….
//
// A dashboard that signs people in itself can still use POST /oauth/consent
// (consent.controller.ts) with the person's bearer token.

const AuthorizeQuery = z.object({
  response_type: z.string().min(1),
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().url().max(2000),
  state: z.string().max(2000).optional(),
  code_challenge: z.string().min(1).max(200),
  code_challenge_method: z.string().default("S256"),
  scope: z.string().max(500).optional(),
  // RFC 8707 resource indicator — MCP clients send the /mcp URL. Accepted and
  // bound into the form token; tokens are valid for this server as a whole.
  resource: z.string().max(2000).optional(),
});

const Email = z.string().trim().toLowerCase().email().max(254);

const FormBody = z.object({
  action: z.enum(["allow", "deny"]).default("allow"),
  mode: z.enum(["signin", "signup"]).default("signin"),
  email: z.string().max(400).optional(),
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  display_name: z.string().max(120).optional(),
  form_token: z.string().max(2000).optional(),
});

const EXPIRED_MESSAGE = "This sign-in page expired or was opened in another tab. Enter your details again.";

@Controller("oauth")
@ApiTags("OAuth (MCP clients)")
export class OauthAuthorizeController {
  constructor(
    private readonly oauth: OauthService,
    private readonly accounts: AccountsService,
    private readonly formTokens: OauthFormTokenService,
  ) {}

  @Get("authorize")
  @ApiOperation({
    summary: "RFC 6749 §4.1.1 authorization endpoint — renders the OpenKT sign-in and consent page",
    description:
      "Validates client_id, redirect_uri, response_type=code and an S256 PKCE challenge, then returns an " +
      "HTML page where the person signs in (or creates an account) and allows the client. " +
      "Unknown client / redirect_uri → 400 error page; other errors → redirect to redirect_uri with ?error=.",
  })
  @ApiQuery({ name: "response_type", required: true, example: "code" })
  @ApiQuery({ name: "client_id", required: true, example: "okt_oauth_<64hex>" })
  @ApiQuery({ name: "redirect_uri", required: true })
  @ApiQuery({ name: "code_challenge", required: true, description: "base64url S256, >= 43 chars" })
  @ApiQuery({ name: "code_challenge_method", required: true, example: "S256" })
  @ApiQuery({ name: "state", required: false })
  @ApiQuery({ name: "scope", required: false, example: "read write" })
  @ApiQuery({ name: "resource", required: false, description: "RFC 8707 resource indicator" })
  @ApiResponse({ status: 200, description: "The sign-in page (text/html)" })
  @ApiResponse({ status: 400, description: "Unknown client or redirect_uri (text/html)" })
  async authorize(@Query() query: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const params = this.parseParams(query, res);
    if (!params) return;
    const client = await this.validate(params, res);
    if (!client) return;
    this.sendSignInPage(req, res, 200, client, params, { mode: "signin" });
  }

  @Post("authorize")
  @ApiExcludeEndpoint()
  async submit(@Body() body: unknown, @Req() req: RequestWithContext, @Res() res: Response): Promise<void> {
    const raw = (body ?? {}) as Record<string, unknown>;
    const params = this.parseParams(raw, res);
    if (!params) return;
    const client = await this.validate(params, res);
    if (!client) return;

    const form = FormBody.safeParse(raw);
    if (!form.success) {
      this.sendSignInPage(req, res, 400, client, params, { mode: "signin", error: "Something in the form was not valid. Try again." });
      return;
    }
    const input = form.data;
    const mode: SignInMode = input.mode;
    const keep = { mode, email: input.email?.trim(), displayName: input.display_name?.trim() };

    const tokenProblem = this.formTokens.problem(input.form_token, readCookie(req, FORM_COOKIE_NAME), params);
    if (tokenProblem) {
      this.sendSignInPage(req, res, 400, client, params, { ...keep, error: EXPIRED_MESSAGE });
      return;
    }

    if (input.action === "deny") {
      redirectWith(res, params, { error: "access_denied", error_description: "The person declined to connect." });
      return;
    }

    const email = Email.safeParse(input.email ?? "");
    if (!email.success || !input.password) {
      this.sendSignInPage(req, res, 400, client, params, { ...keep, error: "Enter your email address and password." });
      return;
    }
    const displayName = input.display_name?.trim() ?? "";
    if (mode === "signup" && !displayName) {
      this.sendSignInPage(req, res, 400, client, params, { ...keep, error: "Enter your name to create an account." });
      return;
    }

    const meta = req.requestMetadata ?? mapRequestMetadata(req);
    let user: SignedInUser;
    try {
      user =
        mode === "signup"
          ? await this.accounts.registerWithPassword({ email: email.data, password: input.password, displayName }, meta)
          : await this.accounts.authenticateWithPassword({ email: email.data, password: input.password }, meta);
    } catch (error) {
      const message = accountErrorMessage(error);
      if (!message) throw error;
      this.sendSignInPage(req, res, message.status, client, params, { ...keep, error: message.text });
      return;
    }

    try {
      const { code } = await this.oauth.mintAuthorizationCode({
        userId: user.userId,
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        codeChallengeMethod: params.code_challenge_method,
        scopes: params.scope ? params.scope.split(/\s+/).filter(Boolean) : undefined,
      });
      clearFormCookie(req, res);
      redirectWith(res, params, { code });
    } catch (error) {
      if (error instanceof OauthError) {
        redirectWith(res, params, { error: error.oauthCode, error_description: error.message });
        return;
      }
      throw error;
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private parseParams(source: unknown, res: Response): AuthorizeParams | null {
    const parsed = AuthorizeQuery.safeParse(source);
    if (!parsed.success) {
      sendPage(
        res,
        400,
        renderErrorPage(
          "This connection link is incomplete",
          "The app that sent you here did not include everything OpenKT needs (client, redirect address and a PKCE challenge).",
        ),
      );
      return null;
    }
    const p = parsed.data;
    return {
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      response_type: p.response_type,
      code_challenge: p.code_challenge,
      code_challenge_method: p.code_challenge_method,
      state: p.state,
      scope: p.scope,
      resource: p.resource,
    };
  }

  private async validate(params: AuthorizeParams, res: Response): Promise<OauthClientRecord | null> {
    try {
      return await this.oauth.loadAuthorizeRequest({
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        responseType: params.response_type,
        codeChallenge: params.code_challenge,
        codeChallengeMethod: params.code_challenge_method,
      });
    } catch (error) {
      if (!(error instanceof OauthError)) throw error;
      if (error.oauthCode === "invalid_client" || error.oauthCode === "invalid_redirect_uri") {
        sendPage(
          res,
          400,
          renderErrorPage(
            error.oauthCode === "invalid_client" ? "This app is not registered with OpenKT" : "This redirect address is not registered",
            error.oauthCode === "invalid_client"
              ? "The app's registration was not found. Remove OpenKT from the app and add it again."
              : "The address the app asked to return to does not match its registration.",
          ),
        );
        return null;
      }
      redirectWith(res, params, { error: error.oauthCode, error_description: error.message });
      return null;
    }
  }

  private sendSignInPage(
    req: Request,
    res: Response,
    status: number,
    client: OauthClientRecord,
    params: AuthorizeParams,
    view: { mode: SignInMode; email?: string; displayName?: string; error?: string },
  ): void {
    const { nonce, token } = this.formTokens.issue(params);
    res.cookie(FORM_COOKIE_NAME, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(req),
      path: "/oauth",
      maxAge: FORM_TOKEN_TTL_SEC * 1000,
    });
    sendPage(
      res,
      status,
      renderSignInPage({
        clientName: client.name,
        redirectUri: params.redirect_uri,
        params,
        formToken: token,
        mode: view.mode,
        email: view.email,
        displayName: view.displayName,
        error: view.error,
      }),
    );
  }
}

function sendPage(res: Response, status: number, page: RenderedPage): void {
  res.status(status);
  for (const [k, v] of Object.entries(page.headers)) res.setHeader(k, v);
  res.send(page.html);
}

function redirectWith(res: Response, params: AuthorizeParams, extra: Record<string, string>): void {
  const url = new URL(params.redirect_uri);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  if (params.state) url.searchParams.set("state", params.state);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url.toString());
}

function clearFormCookie(req: Request, res: Response): void {
  res.clearCookie(FORM_COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: isHttps(req), path: "/oauth" });
}

export function isHttps(req: Request): boolean {
  const forwarded = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  return (forwarded ?? req.protocol) === "https";
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// AccountsService throws HttpException({code, message}); turn the ones a
// person can act on into a sentence for the page. Anything else is a real
// server error and propagates.
export function accountErrorMessage(error: unknown): { status: number; text: string } | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse() as { code?: string; message?: string } | string;
  const code = typeof response === "object" ? response.code : undefined;
  const message = typeof response === "object" ? response.message : undefined;
  switch (code) {
    case "invalid_credentials":
      return { status: 401, text: "That email and password do not match an OpenKT account." };
    case "rate_limited":
      return { status: 429, text: "Too many attempts. Wait a few minutes and try again." };
    case "weak_password":
      return { status: 400, text: capitalize(message ?? "Choose a stronger password.") };
    case "email_taken":
      return { status: 409, text: "An account with this email already exists. Choose Sign in instead." };
    default:
      return null;
  }
}

function capitalize(s: string): string {
  const t = s.endsWith(".") ? s : `${s}.`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
