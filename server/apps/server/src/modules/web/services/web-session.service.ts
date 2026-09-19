import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { profiles } from "../../../db/schema";
import { isHttps, readCookie } from "../../oauth/controllers/authorize.controller";
import {
  PersonalTokensService,
  SESSION_TOKEN_NAME_PREFIX,
} from "../../personal-tokens/services/personal-tokens.service";

// Sign-in state for the zero-install pages (/join/<code>, /connect).
//
// The session is an ordinary access token named `session:web`, valid one day,
// kept in an HttpOnly, SameSite=Lax cookie whose Path is /connect and /join —
// so the browser sends it to these pages only, never to /v1 or /mcp (which do
// not read cookies anyway). Signing out revokes the token.
//
// CSRF: every form carries HMAC(nonce), where the nonce lives in its own
// HttpOnly SameSite=Lax cookie. A form posted from another site arrives
// without that cookie (and with a foreign Origin), so it is refused.

export const SESSION_COOKIE = "okt_web_session";
export const CSRF_COOKIE = "okt_web_csrf";
export const COOKIE_PATHS = ["/connect", "/join"] as const;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const WEB_SESSION_TOKEN_NAME = `${SESSION_TOKEN_NAME_PREFIX}web`;

export interface WebUser {
  userId: string;
  tokenId: string;
  email: string;
  displayName: string | null;
}

@Injectable()
export class WebSessionService {
  private readonly logger = new Logger(WebSessionService.name);
  private readonly key: Buffer;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tokens: PersonalTokensService,
    config: ConfigService,
  ) {
    // The same sources the OAuth sign-in page signs with, so every replica
    // agrees; a different label so the two keys never coincide.
    const source =
      config.get<string>("OPENKT_FORM_SECRET") ??
      config.get<string>("OPENKT_INTERNAL_SERVICE_TOKEN") ??
      config.get<string>("OPENKT_MCP_SERVICE_KEY") ??
      config.get<string>("DATABASE_URL") ??
      process.env.DATABASE_URL;
    if (!source) this.logger.warn("[web] no server secret configured — forms are signed with a per-process key");
    this.key = createHmac("sha256", source ?? randomBytes(32)).update("openkt/web-forms/v1").digest();
  }

  // The CSRF value to put in this response's forms (setting the nonce cookie
  // the first time).
  csrfToken(req: Request, res: Response): string {
    let nonce = readCookie(req, CSRF_COOKIE);
    if (!nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
      nonce = randomBytes(18).toString("base64url");
      for (const path of COOKIE_PATHS) {
        res.cookie(CSRF_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: isHttps(req), path });
      }
    }
    return this.sign(nonce);
  }

  // True when the form came from one of our own pages in this browser.
  csrfOk(req: Request, submitted: unknown): boolean {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null") {
      const host = req.headers.host;
      if (!host || origin !== `${isHttps(req) ? "https" : "http"}://${host}`) return false;
    }
    const nonce = readCookie(req, CSRF_COOKIE);
    if (!nonce || typeof submitted !== "string" || !submitted) return false;
    return safeEqual(submitted, this.sign(nonce));
  }

  async start(req: Request, res: Response, userId: string): Promise<void> {
    const issued = await this.tokens.create({
      userId,
      name: WEB_SESSION_TOKEN_NAME,
      scopes: ["read", "write"],
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    for (const path of COOKIE_PATHS) {
      res.cookie(SESSION_COOKIE, issued.rawToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps(req),
        path,
        maxAge: SESSION_TTL_MS,
      });
    }
  }

  // The signed-in person, or null (no cookie, or a revoked / expired token).
  async current(req: Request): Promise<WebUser | null> {
    const raw = readCookie(req, SESSION_COOKIE);
    if (!raw) return null;
    try {
      const { userId, tokenId } = await this.tokens.verify(raw);
      const [profile] = await this.db
        .select({ email: profiles.email, displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      return { userId, tokenId, email: profile?.email ?? "", displayName: profile?.displayName ?? null };
    } catch {
      return null;
    }
  }

  async end(req: Request, res: Response): Promise<void> {
    const user = await this.current(req);
    if (user) await this.tokens.revoke(user.userId, user.tokenId).catch(() => undefined);
    for (const path of COOKIE_PATHS) {
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: isHttps(req), path });
    }
  }

  private sign(nonce: string): string {
    return createHmac("sha256", this.key).update(`csrf:${nonce}`).digest("base64url");
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
