// Unit tests for the OAuth 2.1 token-exchange path. We drive
// OauthService against a mock Drizzle db so the test can assert error
// shapes + response shape without booting Nest or hitting Postgres.
//
// Coverage:
//   * authorization_code happy path → returns access + refresh tokens
//     in RFC 6749 §5.1 shape
//   * bad client_secret → invalid_client
//   * expired code → invalid_grant
//   * PKCE mismatch → invalid_grant
//   * refresh_token rotation → revokes old PAT row + mints new pair

import { createHash } from "node:crypto";

import {
  OauthError,
  OauthService,
  base64UrlEncode,
  pkceChallengeFromVerifier,
  sha256Hex,
} from "../../apps/server/src/modules/oauth/services/oauth.service";

// ── tiny Drizzle stub ────────────────────────────────────────────────
// We don't reach into drizzle-orm at all here — the service uses the
// chainable `db.select().from(…).where(…).limit(…)`, `db.insert(…).values(…)`,
// `db.update(…).set(…).where(…)` shapes which we mimic with a
// hand-rolled object. The behaviour is keyed off the underlying table
// reference's `_.name` (drizzle-orm exposes the table name on `Symbol("Name")`)
// — instead of poking at internals, we inspect the SQL identity by
// looking at the imported table objects directly.

import {
  oauthAuthorizationCodes,
  oauthClients,
  personalAccessTokens,
} from "../../apps/server/src/db/schema";

type Row = Record<string, unknown>;

class FakeDb {
  public clients: Row[] = [];
  public codes: Row[] = [];
  public tokens: Row[] = [];

  // Internal: pick the right collection for a given drizzle table.
  private collectionFor(table: unknown): Row[] {
    if (table === oauthClients) return this.clients;
    if (table === oauthAuthorizationCodes) return this.codes;
    if (table === personalAccessTokens) return this.tokens;
    throw new Error(`FakeDb: unknown table ${String(table)}`);
  }

  // The service uses where(and(eq(col, val), …)). We track the most
  // recent where-call as a predicate the caller can install via
  // `pendingWhere`. Real production code paths are exercised by the
  // .where() match below — each call sets `pendingWhere` to a function
  // we'll apply when the chain terminates with `.limit()` or directly.
  private pendingTable: unknown = null;
  private pendingWhere: ((row: Row) => boolean) | null = null;
  private pendingInsertValues: Row | null = null;
  private pendingUpdateSet: Row | null = null;
  private pendingReturning = false;

  select() {
    return {
      from: (table: unknown) => {
        this.pendingTable = table;
        this.pendingWhere = null;
        return {
          where: (predicate: (row: Row) => boolean) => {
            this.pendingWhere = predicate;
            return {
              limit: async () => this.runSelect(),
            };
          },
        };
      },
    };
  }

  insert(table: unknown) {
    this.pendingTable = table;
    return {
      values: (row: Row) => {
        this.pendingInsertValues = row;
        const persist = (): Row[] => {
          const collection = this.collectionFor(table);
          const stamped: Row = {
            ...row,
            createdAt: row.createdAt ?? new Date(),
          };
          collection.push(stamped);
          return [stamped];
        };
        return {
          returning: async () => persist(),
          // Some callers chain `.values(…)` directly as a promise
          // (insert with no returning). Support that too.
          then: (resolve: (rows: Row[]) => unknown) => resolve(persist()),
        };
      },
    };
  }

  update(table: unknown) {
    this.pendingTable = table;
    return {
      set: (changes: Row) => {
        this.pendingUpdateSet = changes;
        return {
          where: (predicate: (row: Row) => boolean) => {
            this.pendingWhere = predicate;
            const apply = (): Row[] => {
              const collection = this.collectionFor(table);
              const updated: Row[] = [];
              for (const row of collection) {
                if (predicate(row)) {
                  Object.assign(row, changes);
                  updated.push(row);
                }
              }
              return updated;
            };
            return {
              returning: async () => apply(),
              then: (resolve: (rows: Row[]) => unknown) => resolve(apply()),
            };
          },
        };
      },
    };
  }

  private runSelect(): Row[] {
    const collection = this.collectionFor(this.pendingTable);
    const predicate = this.pendingWhere;
    if (!predicate) return collection.slice(0, 1);
    return collection.filter((row) => predicate(row)).slice(0, 1);
  }
}

// drizzle's `and(...)`, `eq(col, val)`, `isNull(col)` etc. are
// imported by the service from "drizzle-orm". Our service code wraps
// every db call in a chain we control through `FakeDb`, so the
// predicate callbacks the service hands to .where(...) actually arrive
// as drizzle-orm SQL trees, NOT as JS functions. That's a problem for
// a hand-rolled stub.
//
// Workaround: jest.mock("drizzle-orm") so the helpers used by the
// service collapse into the JS-predicate shape FakeDb expects.

jest.mock("drizzle-orm", () => {
  const actual = jest.requireActual("drizzle-orm");

  // Drizzle columns expose `.name` as the SQL column name (snake_case).
  // Our FakeDb rows use the JS camelCase keys, so we map between them.
  function snakeToCamel(name: string): string {
    return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }
  function colKey(col: unknown): string {
    if (typeof col === "string") return snakeToCamel(col);
    if (col && typeof col === "object" && "name" in (col as object)) {
      const n = (col as { name: unknown }).name;
      if (typeof n === "string") return snakeToCamel(n);
    }
    return String(col);
  }

  const eq = (col: unknown, value: unknown) => (row: Record<string, unknown>) =>
    row[colKey(col)] === value;
  const isNull = (col: unknown) => (row: Record<string, unknown>) => {
    const v = row[colKey(col)];
    return v === null || v === undefined;
  };
  const gt = (col: unknown, value: unknown) => (row: Record<string, unknown>) => {
    const left = row[colKey(col)];
    if (left instanceof Date && value instanceof Date) {
      return left.getTime() > value.getTime();
    }
    return Number(left) > Number(value);
  };
  const and = (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) => preds.every((p) => p(row));
  const or = (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) => preds.some((p) => p(row));
  const desc = (col: unknown) => col;
  // sql`…` produces a sentinel; service code only reads `.set(sql\`now()\`)`
  // back from the row, which we just leave as-is.
  const sql = Object.assign((..._args: unknown[]) => "<<sql>>", {
    raw: () => "<<sql>>",
  });

  return { ...actual, eq, isNull, gt, and, or, desc, sql };
});

// Helper: create a registered client row + a code row for an
// "authorization_code" exchange, with given timing + PKCE challenge.
function seedClient(db: FakeDb, clientSecret: string): string {
  const clientId = "okt_oauth_test_client";
  db.clients.push({
    clientId,
    clientSecretHash: sha256Hex(clientSecret),
    name: "Test Client",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    createdBy: null,
    createdAt: new Date(Date.now() - 60_000),
    revokedAt: null,
  });
  return clientId;
}

function seedCode(
  db: FakeDb,
  clientId: string,
  opts: { codeChallenge: string; expiresInMs?: number; used?: boolean },
): string {
  const code = "test-auth-code";
  db.codes.push({
    code,
    clientId,
    userId: "11111111-1111-1111-1111-111111111111",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: opts.codeChallenge,
    codeChallengeMethod: "S256",
    scopes: ["read", "write"],
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 5 * 60 * 1000)),
    usedAt: opts.used ? new Date() : null,
    createdAt: new Date(),
  });
  return code;
}

describe("OauthService.exchangeAuthorizationCode", () => {
  it("happy path returns access + refresh tokens in RFC 6749 §5.1 shape", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "super-secret-xyz";
    const clientId = seedClient(db, secret);
    const verifier = "y".repeat(64);
    const challenge = pkceChallengeFromVerifier(verifier);
    const code = seedCode(db, clientId, { codeChallenge: challenge });

    const result = await svc.exchangeAuthorizationCode({
      code,
      clientId,
      clientSecret: secret,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: verifier,
    });

    expect(result.accessToken.startsWith("okt_pat_")).toBe(true);
    expect(result.refreshToken.startsWith("okt_rt_")).toBe(true);
    expect(result.scopes).toEqual(["read", "write"]);
    expect(result.expiresInSec).toBe(90 * 24 * 60 * 60);

    // A PAT row was inserted with the OAuth client id + refresh hash.
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0].oauthClientId).toBe(clientId);
    expect(db.tokens[0].refreshTokenHash).toBe(sha256Hex(result.refreshToken));
    expect(db.tokens[0].name).toBe(`oauth:${clientId}`);

    // The auth code row is flipped to used_at.
    expect(db.codes[0].usedAt).toBeTruthy();
  });

  it("rejects a bad client_secret with invalid_client", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const clientId = seedClient(db, "the-real-secret");
    const verifier = "y".repeat(64);
    const challenge = pkceChallengeFromVerifier(verifier);
    seedCode(db, clientId, { codeChallenge: challenge });

    await expect(
      svc.exchangeAuthorizationCode({
        code: "test-auth-code",
        clientId,
        clientSecret: "wrong-secret",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({
      oauthCode: "invalid_client",
    });
  });

  it("rejects an expired authorization code with invalid_grant", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "the-secret";
    const clientId = seedClient(db, secret);
    const verifier = "y".repeat(64);
    const challenge = pkceChallengeFromVerifier(verifier);
    seedCode(db, clientId, { codeChallenge: challenge, expiresInMs: -1000 });

    await expect(
      svc.exchangeAuthorizationCode({
        code: "test-auth-code",
        clientId,
        clientSecret: secret,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({
      oauthCode: "invalid_grant",
      message: "authorization code expired",
    });
  });

  it("rejects an already-used authorization code with invalid_grant", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "the-secret";
    const clientId = seedClient(db, secret);
    const verifier = "y".repeat(64);
    const challenge = pkceChallengeFromVerifier(verifier);
    seedCode(db, clientId, { codeChallenge: challenge, used: true });

    await expect(
      svc.exchangeAuthorizationCode({
        code: "test-auth-code",
        clientId,
        clientSecret: secret,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({
      oauthCode: "invalid_grant",
      message: "authorization code already used",
    });
  });

  it("rejects a PKCE verifier that doesn't match the stored challenge", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "the-secret";
    const clientId = seedClient(db, secret);
    // Genuine challenge bound to a DIFFERENT verifier
    const challenge = pkceChallengeFromVerifier("a".repeat(64));
    seedCode(db, clientId, { codeChallenge: challenge });

    await expect(
      svc.exchangeAuthorizationCode({
        code: "test-auth-code",
        clientId,
        clientSecret: secret,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeVerifier: "z".repeat(64),
      }),
    ).rejects.toMatchObject({
      oauthCode: "invalid_grant",
      message: "PKCE verifier mismatch",
    });
  });
});

describe("OauthService.refreshTokens", () => {
  it("rotates: revokes the old PAT and mints a fresh pair", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "rt-secret";
    const clientId = seedClient(db, secret);

    // Seed an existing PAT row with a known refresh token hash.
    const oldRefresh = "okt_rt_" + "a".repeat(64);
    db.tokens.push({
      id: "tok-1",
      userId: "user-1",
      name: "oauth:" + clientId,
      tokenHash: "old-access-hash",
      prefix: "okt_pat_abc",
      scopes: ["read", "write"],
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + 1_000_000),
      revokedAt: null,
      oauthClientId: clientId,
      refreshTokenHash: sha256Hex(oldRefresh),
    });

    const result = await svc.refreshTokens({
      refreshToken: oldRefresh,
      clientId,
      clientSecret: secret,
    });

    expect(result.accessToken).toMatch(/^okt_pat_/);
    expect(result.refreshToken).toMatch(/^okt_rt_/);
    expect(result.refreshToken).not.toBe(oldRefresh);

    // Old row revoked.
    const oldRow = db.tokens.find((r) => r.id === "tok-1")!;
    expect(oldRow.revokedAt).toBeTruthy();
    // New row exists.
    expect(db.tokens).toHaveLength(2);
    const newRow = db.tokens[1];
    expect(newRow.refreshTokenHash).toBe(sha256Hex(result.refreshToken));
    expect(newRow.oauthClientId).toBe(clientId);
  });

  it("rejects refresh token belonging to a different client", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "rt-secret";
    const clientId = seedClient(db, secret);

    const refresh = "okt_rt_" + "b".repeat(64);
    db.tokens.push({
      id: "tok-1",
      userId: "user-1",
      name: "oauth:other",
      tokenHash: "h",
      prefix: "okt_pat_xx",
      scopes: ["read"],
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      oauthClientId: "different-client",
      refreshTokenHash: sha256Hex(refresh),
    });

    await expect(
      svc.refreshTokens({
        refreshToken: refresh,
        clientId,
        clientSecret: secret,
      }),
    ).rejects.toMatchObject({
      oauthCode: "invalid_grant",
    });
  });
});

describe("pkceChallengeFromVerifier", () => {
  it("matches the RFC 7636 §4.2 reference vector", () => {
    // RFC 7636 example:
    //   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(pkceChallengeFromVerifier(verifier)).toBe(expected);
    // Equivalent: base64UrlEncode(SHA-256(verifier))
    expect(
      base64UrlEncode(createHash("sha256").update(verifier).digest()),
    ).toBe(expected);
  });
});

// Sanity check that OauthError surfaces both the oauthCode + message.
describe("OauthError", () => {
  it("carries the oauth code + message", () => {
    const e = new OauthError("invalid_grant", "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.oauthCode).toBe("invalid_grant");
    expect(e.message).toBe("boom");
  });
});
