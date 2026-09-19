import { createPublicKey } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import jwt, { type Algorithm } from "jsonwebtoken";

import { UnauthorizedDomainError } from "@openkt/core-errors";

// Verifies Supabase access tokens LOCALLY using Supabase's JWKS.
//
// Before this was extracted, PrincipalResolutionService called
// `adminClient.auth.getUser(jwt)` on every authenticated request,
// which is a network round-trip to Supabase. 82 routes guarded by
// SupabaseJwtGuard × active users × tabs = hundreds-to-thousands of
// RPM into Supabase, which 429s the project. Signins also fail
// because they share the same rate-limit window.
//
// We fetch Supabase's JWKS once, cache parsed-and-PEM-encoded public
// keys by `kid` for the cache TTL, and verify signatures locally with
// jsonwebtoken. On a `kid` miss we refetch — that covers Supabase's
// signing-key rotation transparently. After warmup, verification is
// pure crypto, zero network.
//
// Tests provide their own implementation of this class via DI so they
// don't pull on the JWKS endpoint or need to mint real signed tokens.

export interface SupabaseJwtClaims {
  sub?: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  role?: string;
  session_id?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// Algorithms we accept. Supabase's modern projects use ES256 (asymmetric)
// per /auth/v1/.well-known/jwks.json. RS256 is in the list for projects
// that use RSA keys instead of EC. HS256 is intentionally absent — JWKS
// only carries asymmetric public keys, and any HS256 token would fail
// the "kid present in JWKS" lookup correctly.
const ACCEPTED_ALGORITHMS: Algorithm[] = ["ES256", "RS256"];

// JWKS shape we care about. Supabase returns an object with `keys: [...]`
// where each entry is a standard RFC 7517 JWK. We accept any kty that
// `crypto.createPublicKey({format: "jwk"})` understands (RSA, EC, OKP).
//
// Index signature satisfies node's `crypto.JsonWebKey` input type without
// us having to import that type explicitly (it lives in node:crypto and
// isn't exported as a value).
interface SupabaseJwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  // RSA
  n?: string;
  e?: string;
  // EC
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

// 1 hour. The JWKS for a given Supabase project is stable; rotations
// flip `kid` and the on-miss refresh covers that immediately. Tuning
// down would just trigger more JWKS fetches with no security gain.
const JWKS_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class SupabaseJwtVerifier {
  private readonly logger = new Logger(SupabaseJwtVerifier.name);
  private readonly jwksUrl: string;
  private readonly expectedIssuer: string;

  // kid → PEM string. Empty until first verify() call.
  private keys = new Map<string, string>();
  private fetchedAt = 0;
  // Coalesce concurrent fetches under a single in-flight promise so a
  // burst of requests on a cold cache produces one JWKS GET, not N.
  private inflight: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {
    const supabaseUrl = (this.config.get<string>("SUPABASE_URL") ?? "").replace(
      /\/+$/,
      "",
    );
    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL must be configured for JWT verification");
    }
    this.expectedIssuer = `${supabaseUrl}/auth/v1`;
    this.jwksUrl = `${this.expectedIssuer}/.well-known/jwks.json`;
  }

  async verify(token: string): Promise<SupabaseJwtClaims> {
    const kid = peekKid(token);
    if (!kid) {
      throw new UnauthorizedDomainError("invalid or expired bearer token");
    }

    let pem = await this.resolveKey(kid);
    if (!pem) {
      // Unknown kid — could be a fresh Supabase rotation. Force-refresh
      // the JWKS once and try again. If still missing the token is
      // really invalid (or signed by a key we don't know).
      await this.refreshJwks();
      pem = this.keys.get(kid) ?? null;
      if (!pem) {
        throw new UnauthorizedDomainError("invalid or expired bearer token");
      }
    }

    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        pem!,
        {
          algorithms: ACCEPTED_ALGORITHMS,
          issuer: this.expectedIssuer,
          audience: "authenticated",
        },
        (err, decoded) => {
          if (err) {
            this.logger.debug(`[jwt-verify] ${err.name}: ${err.message}`);
            reject(
              new UnauthorizedDomainError("invalid or expired bearer token"),
            );
            return;
          }
          if (!decoded || typeof decoded !== "object") {
            reject(
              new UnauthorizedDomainError("invalid or expired bearer token"),
            );
            return;
          }
          resolve(decoded as SupabaseJwtClaims);
        },
      );
    });
  }

  private async resolveKey(kid: string): Promise<string | null> {
    const cached = this.keys.get(kid);
    const fresh = Date.now() - this.fetchedAt < JWKS_TTL_MS;
    if (cached && fresh) return cached;
    if (!fresh) {
      await this.refreshJwks();
    }
    return this.keys.get(kid) ?? null;
  }

  private async refreshJwks(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.doFetchJwks().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async doFetchJwks(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.jwksUrl, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      this.logger.warn(
        `[jwks-fetch] ${err instanceof Error ? err.message : String(err)}`,
      );
      // Keep stale keys rather than failing closed — losing the JWKS
      // endpoint shouldn't take down every authenticated request.
      return;
    }
    if (!res.ok) {
      this.logger.warn(`[jwks-fetch] status ${res.status}`);
      return;
    }
    const body = (await res.json()) as { keys?: SupabaseJwk[] };
    if (!body.keys || !Array.isArray(body.keys)) {
      this.logger.warn("[jwks-fetch] response missing keys[]");
      return;
    }
    const next = new Map<string, string>();
    for (const jwk of body.keys) {
      if (!jwk.kid) continue;
      try {
        const pem = createPublicKey({
          key: jwk,
          format: "jwk",
        }).export({ type: "spki", format: "pem" }) as string;
        next.set(jwk.kid, pem);
      } catch (err) {
        this.logger.warn(
          `[jwks-fetch] failed to import kid=${jwk.kid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.keys = next;
    this.fetchedAt = Date.now();
  }
}

function peekKid(token: string): string | null {
  // Header is the first dot-separated segment, base64url-encoded JSON.
  // Don't use jwt.decode here — we want to fail fast on malformed input
  // without dragging the verification path through it.
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const headerB64 = token.slice(0, dot);
  try {
    const json = Buffer.from(headerB64, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { kid?: string };
    return typeof parsed.kid === "string" ? parsed.kid : null;
  } catch {
    return null;
  }
}
