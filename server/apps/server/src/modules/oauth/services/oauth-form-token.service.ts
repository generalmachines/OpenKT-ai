import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// CSRF protection for the server-rendered sign-in page at /oauth/authorize.
//
// Two things must match for a POST to be accepted:
//   1. `form_token` — an HMAC-signed, short-lived token that names the exact
//      authorize parameters the page was rendered for (client, redirect_uri,
//      state, PKCE challenge, scope, resource). A token minted for one flow
//      cannot be replayed against another.
//   2. a nonce cookie (`okt_oauth_form`, HttpOnly, SameSite=Lax, Path=/oauth)
//      set when the page was rendered and also named inside the token. A
//      cross-site form post does not carry a SameSite=Lax cookie, so a page on
//      another site cannot submit the form on someone's behalf.
//
// The signing key is derived (HMAC with a fixed label) from the first of
// OPENKT_FORM_SECRET, OPENKT_INTERNAL_SERVICE_TOKEN, OPENKT_MCP_SERVICE_KEY or
// DATABASE_URL that is set — every replica of one deployment shares those, so a
// page rendered by one process verifies on another and after a restart. With
// none of them set (a bare local run) the key is random per process.

export const FORM_COOKIE_NAME = "okt_oauth_form";
export const FORM_TOKEN_TTL_SEC = 15 * 60;

export type FormTokenProblem = "missing" | "malformed" | "bad_signature" | "expired" | "params_mismatch" | "cookie_mismatch";

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
  resource?: string;
}

interface Payload {
  v: 1;
  n: string; // nonce, also in the cookie
  e: number; // expiry, unix seconds
  h: string; // sha256 of the canonical authorize params
}

@Injectable()
export class OauthFormTokenService {
  private readonly logger = new Logger(OauthFormTokenService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const source =
      config.get<string>("OPENKT_FORM_SECRET") ??
      config.get<string>("OPENKT_INTERNAL_SERVICE_TOKEN") ??
      config.get<string>("OPENKT_MCP_SERVICE_KEY") ??
      config.get<string>("DATABASE_URL") ??
      process.env.DATABASE_URL;
    if (!source) {
      this.logger.warn("[oauth] no server secret configured — sign-in forms are signed with a per-process key");
    }
    this.key = createHmac("sha256", source ?? randomBytes(32)).update("openkt/oauth-form/v1").digest();
  }

  // A fresh nonce (for the cookie) and the token that names it.
  issue(params: AuthorizeParams, nowMs = Date.now()): { nonce: string; token: string } {
    const nonce = randomBytes(18).toString("base64url");
    const payload: Payload = { v: 1, n: nonce, e: Math.floor(nowMs / 1000) + FORM_TOKEN_TTL_SEC, h: paramsHash(params) };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { nonce, token: `${body}.${this.sign(body)}` };
  }

  // null when the token is valid for these params and this cookie.
  problem(
    token: string | undefined,
    cookieNonce: string | undefined,
    params: AuthorizeParams,
    nowMs = Date.now(),
  ): FormTokenProblem | null {
    if (!token) return "missing";
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return "malformed";
    if (!safeEqual(sig, this.sign(body))) return "bad_signature";
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    } catch {
      return "malformed";
    }
    if (payload.v !== 1 || typeof payload.e !== "number" || typeof payload.n !== "string") return "malformed";
    if (payload.e * 1000 <= nowMs) return "expired";
    if (!safeEqual(payload.h, paramsHash(params))) return "params_mismatch";
    if (!cookieNonce || !safeEqual(payload.n, cookieNonce)) return "cookie_mismatch";
    return null;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

// Order-fixed and length-prefixed so no two parameter sets hash alike.
export function paramsHash(p: AuthorizeParams): string {
  const fields = [
    p.client_id,
    p.redirect_uri,
    p.response_type,
    p.code_challenge,
    p.code_challenge_method,
    p.state ?? "",
    p.scope ?? "",
    p.resource ?? "",
  ];
  const h = createHash("sha256");
  for (const f of fields) h.update(`${f.length}:${f};`);
  return h.digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
