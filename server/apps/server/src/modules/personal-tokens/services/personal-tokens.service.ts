import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gt, isNull, like, ne, or, sql } from "drizzle-orm";

import {
  NotFoundDomainError,
  UnauthorizedDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  personalAccessTokens,
  type PersonalAccessToken,
} from "../../../db/schema/personal-access-tokens";

// Token shape: `okt_pat_<64 hex chars>`. The prefix is deliberately
// distinctive so secret scanners + grep over codebases catch leaked
// tokens. 32 random bytes (~256 bits) is plenty of entropy.
export const TOKEN_PREFIX = "okt_pat_";
// Sign-in sessions of the built-in accounts ARE access tokens, told apart only
// by their name: `session:desktop`, `session:web`, `session:cli`.
export const SESSION_TOKEN_NAME_PREFIX = "session:";
const RAW_BYTES = 32;

export interface IssuedToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  prefix: string;
  // The full raw token is only present in the response to `create()` —
  // never stored, never returned again. Caller must surface it to the
  // user once and discard.
  rawToken: string;
}

export interface TokenSummary {
  id: string;
  name: string;
  scopes: string[];
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

@Injectable()
export class PersonalTokensService {
  private readonly logger = new Logger(PersonalTokensService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(input: {
    userId: string;
    name: string;
    scopes?: string[];
    expiresAt?: Date | null;
  }): Promise<IssuedToken> {
    if (!input.name || input.name.length > 64) {
      throw new ValidationDomainError("token name required (1-64 chars)");
    }
    const scopes = normalizeScopes(input.scopes);

    const raw = `${TOKEN_PREFIX}${randomBytes(RAW_BYTES).toString("hex")}`;
    const tokenHash = sha256Hex(raw);
    const prefix = raw.slice(0, 12); // okt_pat_xxxx

    const [row] = await this.db
      .insert(personalAccessTokens)
      .values({
        userId: input.userId,
        name: input.name,
        tokenHash,
        prefix,
        scopes,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();

    if (!row) throw new ValidationDomainError("token create failed");
    this.logger.log(
      `[pat] issued name="${input.name}" user=${input.userId} prefix=${prefix}`,
    );
    return {
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      prefix: row.prefix,
      rawToken: raw,
    };
  }

  async list(userId: string): Promise<TokenSummary[]> {
    const rows = await this.db
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.userId, userId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .orderBy(desc(personalAccessTokens.createdAt));
    return rows.map(toSummary);
  }

  async revoke(userId: string, tokenId: string): Promise<void> {
    const result = await this.db
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(personalAccessTokens.id, tokenId),
          eq(personalAccessTokens.userId, userId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning({ id: personalAccessTokens.id });
    if (result.length === 0) {
      throw new NotFoundDomainError("token not found or already revoked");
    }
    this.logger.log(`[pat] revoked id=${tokenId} user=${userId}`);
  }

  // Revoke every sign-in session of a user, optionally sparing one (the
  // session that asked — a password change signs out everywhere else).
  // Hand-made access tokens are left alone: the person named and placed those
  // deliberately, and revokes them one by one under /v1/me/tokens.
  async revokeSessions(userId: string, exceptTokenId?: string | null): Promise<number> {
    const result = await this.db
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(personalAccessTokens.userId, userId),
          like(personalAccessTokens.name, `${SESSION_TOKEN_NAME_PREFIX}%`),
          isNull(personalAccessTokens.revokedAt),
          exceptTokenId ? ne(personalAccessTokens.id, exceptTokenId) : undefined,
        ),
      )
      .returning({ id: personalAccessTokens.id });
    if (result.length > 0) {
      this.logger.log(`[pat] revoked ${result.length} session(s) user=${userId}`);
    }
    return result.length;
  }

  // Bearer resolver: takes a raw `okt_pat_…` token, returns the owning
  // user id + scopes when valid, throws UnauthorizedDomainError otherwise.
  // Stamps `last_used_at` (best effort, fire-and-forget) so we can spot
  // dormant tokens later.
  async verify(rawToken: string): Promise<{ userId: string; scopes: string[]; tokenId: string }> {
    if (!rawToken.startsWith(TOKEN_PREFIX)) {
      throw new UnauthorizedDomainError("invalid token format");
    }
    const tokenHash = sha256Hex(rawToken);
    const rows = await this.db
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.tokenHash, tokenHash),
          isNull(personalAccessTokens.revokedAt),
          // Allow null expiresAt OR future expiry. SQL: expires_at IS NULL OR expires_at > now()
          or(
            isNull(personalAccessTokens.expiresAt),
            gt(personalAccessTokens.expiresAt, sql`now()`),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedDomainError("invalid or expired token");
    }
    // Touch last_used_at off the hot path — a failure here must not
    // block the actual request.
    void this.db
      .update(personalAccessTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(personalAccessTokens.id, row.id))
      .catch(() => undefined);
    return { userId: row.userId, scopes: row.scopes, tokenId: row.id };
  }
}

function normalizeScopes(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return ["read", "write"];
  const allowed = new Set(["read", "write", "admin"]);
  const out = Array.from(
    new Set(
      input
        .map((s) => s.trim().toLowerCase())
        .filter((s) => allowed.has(s)),
    ),
  );
  if (out.length === 0) {
    throw new ValidationDomainError(
      "scopes must include at least one of: read, write, admin",
    );
  }
  return out;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toSummary(row: PersonalAccessToken): TokenSummary {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
  };
}
