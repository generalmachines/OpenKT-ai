import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import jwt from "jsonwebtoken";

import { JwksKeyCache, peekKid, type JwksFetcher } from "../../auth/services/jwks-key-cache";

// Verifies a Google ID token (the JWT a Google Sign-In button hands the
// client) locally — signature against Google's published keys, then issuer,
// audience, expiry and `email_verified`. No Google SDK, no call to Google per
// sign-in: the same JWKS cache + `jsonwebtoken` pair the Supabase verifier uses.

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: [string, ...string[]] = ["accounts.google.com", "https://accounts.google.com"];
// Used only when Google's response carries no `cache-control: max-age`.
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;

// DI token for the JWKS fetcher — tests inject one that serves a locally
// generated key, so no test touches the network.
export const GOOGLE_JWKS_FETCHER = Symbol("GOOGLE_JWKS_FETCHER");

export interface GoogleIdentity {
  sub: string;
  email: string; // lower-cased
  name: string | null;
  picture: string | null;
}

export class GoogleTokenRejectedError extends Error {}

@Injectable()
export class GoogleIdTokenVerifier {
  private readonly logger = new Logger(GoogleIdTokenVerifier.name);
  private readonly jwks: JwksKeyCache;

  constructor(
    private readonly config: ConfigService,
    @Inject(GOOGLE_JWKS_FETCHER) fetcher: JwksFetcher,
  ) {
    this.jwks = new JwksKeyCache(GOOGLE_JWKS_URL, DEFAULT_JWKS_TTL_MS, fetcher);
  }

  // The OAuth client ids whose tokens this server accepts. Empty → Google
  // sign-in is off.
  clientIds(): string[] {
    return (this.config.get<string>("OPENKT_GOOGLE_CLIENT_IDS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }

  enabled(): boolean {
    return this.clientIds().length > 0;
  }

  // Resolves to the verified identity, or throws GoogleTokenRejectedError.
  // The reason is logged, never returned to the caller.
  async verify(idToken: string): Promise<GoogleIdentity> {
    const audiences = this.clientIds();
    if (audiences.length === 0) throw new GoogleTokenRejectedError("google sign-in is disabled");

    const kid = peekKid(idToken);
    const pem = kid ? await this.jwks.getKey(kid) : null;
    if (!pem) throw this.rejected("unknown signing key");

    let claims: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(idToken, pem, {
        algorithms: ["RS256"],
        issuer: GOOGLE_ISSUERS,
        audience: audiences as [string, ...string[]],
      });
      if (!decoded || typeof decoded !== "object") throw new Error("payload is not an object");
      claims = decoded;
    } catch (err) {
      throw this.rejected(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }

    // jsonwebtoken only checks `exp` when present; a Google ID token always has one.
    if (typeof claims.exp !== "number") throw this.rejected("no exp claim");
    if (typeof claims.sub !== "string" || !claims.sub) throw this.rejected("no sub claim");
    if (typeof claims.email !== "string" || !claims.email) throw this.rejected("no email claim");
    // Strictly `true`: Google sends a boolean. An unverified address must never
    // sign in as — or be linked to — the account that owns that email.
    if (claims.email_verified !== true) throw this.rejected("email not verified");

    return {
      sub: claims.sub,
      email: claims.email.trim().toLowerCase(),
      name: typeof claims.name === "string" && claims.name ? claims.name : null,
      picture: typeof claims.picture === "string" && claims.picture ? claims.picture : null,
    };
  }

  private rejected(reason: string): GoogleTokenRejectedError {
    this.logger.debug(`[google-id-token] rejected: ${reason}`);
    return new GoogleTokenRejectedError(reason);
  }
}
