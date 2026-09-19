import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import jwt, { type Algorithm } from "jsonwebtoken";

import { UnauthorizedDomainError } from "@openkt/core-errors";

import { JwksKeyCache, peekKid } from "./jwks-key-cache";

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

// 1 hour. The JWKS for a given Supabase project is stable; rotations
// flip `kid` and the on-miss refresh covers that immediately. Tuning
// down would just trigger more JWKS fetches with no security gain.
const JWKS_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class SupabaseJwtVerifier {
  private readonly logger = new Logger(SupabaseJwtVerifier.name);
  // Null when SUPABASE_URL is unset: Supabase sign-in is optional, and a
  // server without it accepts only `okt_pat_…` access tokens (built-in
  // accounts mint those). Every JWT is then rejected with a plain 401.
  private readonly expectedIssuer: string | null;
  private readonly jwks: JwksKeyCache | null;

  constructor(private readonly config: ConfigService) {
    const supabaseUrl = (this.config.get<string>("SUPABASE_URL") ?? "").replace(
      /\/+$/,
      "",
    );
    this.expectedIssuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : null;
    this.jwks = this.expectedIssuer
      ? new JwksKeyCache(`${this.expectedIssuer}/.well-known/jwks.json`, JWKS_TTL_MS)
      : null;
  }

  async verify(token: string): Promise<SupabaseJwtClaims> {
    const { jwks, expectedIssuer } = this;
    if (!jwks || !expectedIssuer) {
      throw new UnauthorizedDomainError("invalid or expired bearer token");
    }
    const kid = peekKid(token);
    if (!kid) {
      throw new UnauthorizedDomainError("invalid or expired bearer token");
    }

    // An unknown kid could be a fresh Supabase rotation; the cache refetches
    // once on a miss. Still missing → the token is signed by a key we don't know.
    const pem = await jwks.getKey(kid);
    if (!pem) {
      throw new UnauthorizedDomainError("invalid or expired bearer token");
    }

    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        pem,
        {
          algorithms: ACCEPTED_ALGORITHMS,
          issuer: expectedIssuer,
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
}
