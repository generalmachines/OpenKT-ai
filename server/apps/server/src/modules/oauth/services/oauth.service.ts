import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  oauthAuthorizationCodes,
  oauthClients,
  personalAccessTokens,
} from "../../../db/schema";
import { TOKEN_PREFIX } from "../../personal-tokens/services/personal-tokens.service";

// OAuth 2.1 building blocks. Each method maps 1:1 to a controller route
// so the HTTP layer stays a thin shell and the unit tests can drive the
// flow against a mocked Drizzle db without booting Nest.
//
// Tokens issued here ride the existing `personal_access_tokens` table
// so the BearerAuthGuard's `okt_pat_…` resolver picks them up unchanged.
// We tag rows with `oauth_client_id` so the dashboard's "active tokens"
// list can distinguish dashboard-minted PATs from Claude.ai-style DCR
// installs in a follow-up patch.

export const OAUTH_CLIENT_ID_PREFIX = "okt_oauth_";
const ACCESS_TOKEN_PREFIX = TOKEN_PREFIX; // okt_pat_…
const REFRESH_TOKEN_PREFIX = "okt_rt_";
const RAW_BYTES = 32;
const ACCESS_TOKEN_TTL_SEC = 90 * 24 * 60 * 60; // 90 days, in seconds
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SCOPES = ["read", "write"] as const;

export class OauthError extends Error {
  constructor(
    public readonly oauthCode:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unsupported_grant_type"
      | "invalid_redirect_uri",
    message: string,
  ) {
    super(message);
    this.name = "OauthError";
  }
}

export interface RegisteredClient {
  clientId: string;
  // Only present for confidential clients (token_endpoint_auth_method =
  // "client_secret_post" / "client_secret_basic"). Undefined for public clients ("none").
  clientSecret: string | undefined;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientIdIssuedAt: number;
  name: string;
  redirectUris: string[];
}

export type TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic" | "none";

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresInSec: number;
}

export interface OauthClientRecord {
  clientId: string;
  name: string;
  redirectUris: string[];
}

@Injectable()
export class OauthService {
  private readonly logger = new Logger(OauthService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── RFC 7591 Dynamic Client Registration ────────────────────────────
  //
  // Supports both confidential clients (default, token_endpoint_auth_method
  // = "client_secret_post") and public clients ("none"). Claude.ai
  // registers as a public client and uses PKCE exclusively — it sends no
  // client_secret at the token endpoint. Confidential clients (Cursor,
  // VS Code, headless CI tools that can store a secret) continue to use
  // client_secret_post unchanged.
  async register(input: {
    clientName?: string;
    redirectUris: string[];
    createdBy?: string | null;
    tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  }): Promise<RegisteredClient> {
    if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new OauthError(
        "invalid_redirect_uri",
        "redirect_uris must be a non-empty array",
      );
    }
    for (const uri of input.redirectUris) {
      assertValidRedirectUri(uri);
    }

    const authMethod = input.tokenEndpointAuthMethod ?? "client_secret_post";
    const isPublic = authMethod === "none";

    const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomHex(RAW_BYTES)}`;
    const name = (input.clientName ?? "Claude.ai connector").slice(0, 200);

    // Confidential clients get a secret; public clients do not.
    const clientSecret = isPublic ? undefined : randomHex(RAW_BYTES);
    const clientSecretHash = clientSecret ? sha256Hex(clientSecret) : null;

    const [row] = await this.db
      .insert(oauthClients)
      .values({
        clientId,
        clientSecretHash,
        tokenEndpointAuthMethod: authMethod,
        name,
        redirectUris: input.redirectUris,
        createdBy: input.createdBy ?? null,
      })
      .returning();

    if (!row) {
      throw new OauthError("invalid_request", "client registration failed");
    }
    this.logger.log(
      `[oauth] client registered id=${clientId} name="${name}" method=${authMethod} uris=${input.redirectUris.length}`,
    );

    return {
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: authMethod,
      clientIdIssuedAt: Math.floor(row.createdAt.getTime() / 1000),
      name,
      redirectUris: input.redirectUris,
    };
  }

  // ── /oauth/authorize pre-check ─────────────────────────────────────
  // Returns the validated client + a list of params the dashboard will
  // need to re-POST to /oauth/consent. Throws OauthError otherwise.
  async loadAuthorizeRequest(input: {
    clientId: string;
    redirectUri: string;
    responseType: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  }): Promise<OauthClientRecord> {
    if (input.responseType !== "code") {
      throw new OauthError(
        "invalid_request",
        "response_type must be 'code'",
      );
    }
    if (input.codeChallengeMethod !== "S256") {
      throw new OauthError(
        "invalid_request",
        "code_challenge_method must be 'S256'",
      );
    }
    if (!input.codeChallenge || input.codeChallenge.length < 43) {
      throw new OauthError(
        "invalid_request",
        "code_challenge is required (base64url, >=43 chars)",
      );
    }
    const client = await this.lookupClient(input.clientId);
    if (!client) {
      throw new OauthError("invalid_client", "unknown client_id");
    }
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new OauthError(
        "invalid_redirect_uri",
        "redirect_uri does not match a registered URI",
      );
    }
    return {
      clientId: client.clientId,
      name: client.name,
      redirectUris: client.redirectUris,
    };
  }

  // ── /oauth/consent mint ─────────────────────────────────────────────
  // Called by the dashboard once the user has signed in via Supabase and
  // (optionally) clicked Allow. Persists the code + binds it to the
  // authenticated user.
  async mintAuthorizationCode(input: {
    userId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scopes?: string[];
  }): Promise<{ code: string; expiresAt: Date }> {
    const client = await this.lookupClient(input.clientId);
    if (!client) {
      throw new OauthError("invalid_client", "unknown client_id");
    }
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new OauthError(
        "invalid_redirect_uri",
        "redirect_uri does not match a registered URI",
      );
    }
    if (input.codeChallengeMethod !== "S256") {
      throw new OauthError(
        "invalid_request",
        "code_challenge_method must be 'S256'",
      );
    }

    const code = randomHex(RAW_BYTES);
    const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);
    const scopes = normalizeScopes(input.scopes);

    await this.db.insert(oauthAuthorizationCodes).values({
      code,
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scopes,
      expiresAt,
    });
    this.logger.log(
      `[oauth] auth code minted client=${input.clientId} user=${input.userId}`,
    );
    return { code, expiresAt };
  }

  // ── /oauth/token grant_type=authorization_code ──────────────────────
  //
  // Public clients (token_endpoint_auth_method = "none") omit the
  // client_secret entirely — PKCE (code_verifier) is their proof of
  // possession. Confidential clients must still supply client_secret.
  async exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    clientSecret?: string | null;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<IssuedTokenPair> {
    await this.assertClientCredentials(input.clientId, input.clientSecret ?? null);

    const rows = await this.db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.code, input.code))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new OauthError("invalid_grant", "authorization code not found");
    }
    if (row.usedAt) {
      // RFC 6749 §10.5 — single-use codes. Don't leak whether the same
      // code was previously redeemed by a different client.
      throw new OauthError("invalid_grant", "authorization code already used");
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new OauthError("invalid_grant", "authorization code expired");
    }
    if (row.clientId !== input.clientId) {
      throw new OauthError("invalid_grant", "client_id does not match code");
    }
    if (row.redirectUri !== input.redirectUri) {
      throw new OauthError(
        "invalid_grant",
        "redirect_uri does not match code",
      );
    }

    // PKCE verify: S256(verifier) must equal stored code_challenge.
    if (row.codeChallengeMethod === "S256") {
      const expected = base64UrlEncode(
        createHash("sha256").update(input.codeVerifier).digest(),
      );
      if (expected !== row.codeChallenge) {
        throw new OauthError("invalid_grant", "PKCE verifier mismatch");
      }
    } else if (row.codeChallengeMethod === "plain") {
      if (input.codeVerifier !== row.codeChallenge) {
        throw new OauthError("invalid_grant", "PKCE verifier mismatch");
      }
    } else {
      throw new OauthError(
        "invalid_grant",
        "unsupported code_challenge_method",
      );
    }

    // Flip the code to used before minting so concurrent redeems lose.
    const consumed = await this.db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(oauthAuthorizationCodes.code, input.code),
          isNull(oauthAuthorizationCodes.usedAt),
        ),
      )
      .returning({ code: oauthAuthorizationCodes.code });
    if (consumed.length === 0) {
      throw new OauthError("invalid_grant", "authorization code already used");
    }

    return this.issueTokenPair({
      userId: row.userId,
      clientId: row.clientId,
      scopes: row.scopes,
    });
  }

  // ── /oauth/token grant_type=refresh_token ───────────────────────────
  //
  // Public clients omit client_secret here too; the refresh token itself
  // is the credential. Confidential clients must still supply
  // client_secret.
  async refreshTokens(input: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string | null;
  }): Promise<IssuedTokenPair> {
    await this.assertClientCredentials(input.clientId, input.clientSecret ?? null);

    if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
      throw new OauthError("invalid_grant", "invalid refresh token format");
    }
    const refreshTokenHash = sha256Hex(input.refreshToken);
    const rows = await this.db
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.refreshTokenHash, refreshTokenHash),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new OauthError("invalid_grant", "refresh token not recognised");
    }
    if (row.oauthClientId !== input.clientId) {
      throw new OauthError(
        "invalid_grant",
        "refresh token does not belong to this client",
      );
    }

    // Rotate: revoke the old PAT row (which holds both the access and
    // refresh secret) and mint a fresh pair. Per OAuth 2.1 §6.1, refresh
    // tokens MUST be single-use; rotation closes the replay window.
    await this.db
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(eq(personalAccessTokens.id, row.id));

    return this.issueTokenPair({
      userId: row.userId,
      clientId: input.clientId,
      scopes: row.scopes,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────

  // Validates client identity at the token endpoint.
  //
  // Dispatch rules:
  //   * Public clients (tokenEndpointAuthMethod = "none") — the client_id
  //     alone identifies the client; no secret check. Callers MUST verify
  //     PKCE after this returns.
  //   * Confidential clients ("client_secret_post") — clientSecret is
  //     required and must hash-match the stored value.
  //
  // Passing clientSecret = null for a confidential client throws
  // invalid_client so callers don't have to guard the type themselves.
  private async assertClientCredentials(
    clientId: string,
    clientSecret: string | null,
  ): Promise<void> {
    const client = await this.lookupClient(clientId);
    if (!client) {
      throw new OauthError("invalid_client", "unknown client_id");
    }

    const isPublic = client.tokenEndpointAuthMethod === "none";
    if (isPublic) {
      // Public clients are identified by client_id only. A client_secret
      // sent accidentally is silently ignored — the PKCE verifier is the
      // proof of possession.
      return;
    }

    // Confidential client — must supply a matching secret.
    if (!clientSecret) {
      throw new OauthError(
        "invalid_client",
        "client_secret required for confidential client",
      );
    }
    if (!client.clientSecretHash || sha256Hex(clientSecret) !== client.clientSecretHash) {
      throw new OauthError("invalid_client", "client_secret mismatch");
    }
  }

  private async lookupClient(clientId: string) {
    const rows = await this.db
      .select()
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.clientId, clientId),
          isNull(oauthClients.revokedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async issueTokenPair(input: {
    userId: string;
    clientId: string;
    scopes: string[];
  }): Promise<IssuedTokenPair> {
    const accessRaw = `${ACCESS_TOKEN_PREFIX}${randomHex(RAW_BYTES)}`;
    const refreshRaw = `${REFRESH_TOKEN_PREFIX}${randomHex(RAW_BYTES)}`;
    const tokenHash = sha256Hex(accessRaw);
    const refreshHash = sha256Hex(refreshRaw);
    const prefix = accessRaw.slice(0, 12);
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);

    await this.db.insert(personalAccessTokens).values({
      userId: input.userId,
      name: `oauth:${input.clientId}`,
      tokenHash,
      prefix,
      scopes: input.scopes,
      expiresAt,
      oauthClientId: input.clientId,
      refreshTokenHash: refreshHash,
    });

    return {
      accessToken: accessRaw,
      refreshToken: refreshRaw,
      scopes: input.scopes,
      expiresInSec: ACCESS_TOKEN_TTL_SEC,
    };
  }
}

// ── exported pure helpers (unit-testable without DI) ──────────────────
export function assertValidRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new OauthError("invalid_redirect_uri", `redirect_uri not a URL: ${uri}`);
  }
  // 1. https:// — production web clients (Claude.ai, ChatGPT, …)
  if (parsed.protocol === "https:") return;
  // 2. http://localhost — local dev + smoke (RFC 8252 §7.3)
  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && isLocalhost) return;
  // 3. Private-use URI schemes — native MCP clients (Cursor, VS Code,
  //    Claude desktop, …) register OAuth callbacks under their own
  //    scheme per RFC 8252 §7.1. We accept any non-http(s) scheme that
  //    looks like a real URI scheme (alpha first char, ASCII alnum +
  //    "+ - ." after) so we still reject obvious junk. We deliberately
  //    do NOT enforce a reverse-DNS shape: real-world clients use
  //    short schemes like "cursor", "vscode", "anthropic" and refusing
  //    those would mean refusing the integration entirely.
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "javascript:" &&
    parsed.protocol !== "data:" &&
    parsed.protocol !== "file:" &&
    /^[a-z][a-z0-9+\-.]*:$/i.test(parsed.protocol)
  ) {
    return;
  }
  throw new OauthError(
    "invalid_redirect_uri",
    `redirect_uri must use https://, http://localhost, or a private-use URI scheme (e.g. cursor://, vscode://): ${uri}`,
  );
}

export function normalizeScopes(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return [...DEFAULT_SCOPES];
  const allowed = new Set(["read", "write", "admin"]);
  const out = Array.from(
    new Set(
      input
        .map((s) => s.trim().toLowerCase())
        .filter((s) => allowed.has(s)),
    ),
  );
  return out.length === 0 ? [...DEFAULT_SCOPES] : out;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// expose for tests that need to mint a PKCE pair without re-implementing
export function pkceChallengeFromVerifier(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

// `gt` is intentionally unused here — the time-window check happens in
// JS so we can produce the right OauthError shape — but importing it
// keeps the file aligned with Drizzle helpers we may need if we later
// move the expiry check into SQL.
void gt;
