// Unit tests for GAP 3: public-client (token_endpoint_auth_method = "none")
// Dynamic Client Registration and token exchange.
//
// Claude.ai registers with method="none" and sends no client_secret at
// the token endpoint — it uses PKCE (code_verifier) as proof of
// possession. This test file covers:
//
//   * OauthService.register with method="none" → no client_secret
//     returned, tokenEndpointAuthMethod echoed as "none"
//   * OauthService.exchangeAuthorizationCode for a public client with
//     no clientSecret → succeeds via PKCE
//   * OauthService.exchangeAuthorizationCode for a confidential client
//     with no clientSecret → fails invalid_client
//   * OauthService.refreshTokens for a public client with no clientSecret
//     → succeeds
//   * Confidential client still requires client_secret → invalid_client

import {
  OauthError,
  OauthService,
  pkceChallengeFromVerifier,
  sha256Hex,
  OAUTH_CLIENT_ID_PREFIX,
} from "../../apps/server/src/modules/oauth/services/oauth.service";

import {
  oauthAuthorizationCodes,
  oauthClients,
  personalAccessTokens,
} from "../../apps/server/src/db/schema";

// ── drizzle-orm mock (same pattern as oauth-token-exchange.spec.ts) ──

jest.mock("drizzle-orm", () => {
  const actual = jest.requireActual("drizzle-orm");
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
    if (left instanceof Date && value instanceof Date) return left.getTime() > value.getTime();
    return Number(left) > Number(value);
  };
  const and = (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) => preds.every((p) => p(row));
  const sql = Object.assign((..._args: unknown[]) => "<<sql>>", { raw: () => "<<sql>>" });
  return { ...actual, eq, isNull, gt, and, sql };
});

type Row = Record<string, unknown>;

class FakeDb {
  public clients: Row[] = [];
  public codes: Row[] = [];
  public tokens: Row[] = [];

  private collectionFor(table: unknown): Row[] {
    if (table === oauthClients) return this.clients;
    if (table === oauthAuthorizationCodes) return this.codes;
    if (table === personalAccessTokens) return this.tokens;
    throw new Error(`FakeDb: unknown table ${String(table)}`);
  }

  private pendingTable: unknown = null;
  private pendingWhere: ((row: Row) => boolean) | null = null;

  select() {
    return {
      from: (table: unknown) => {
        this.pendingTable = table;
        this.pendingWhere = null;
        return {
          where: (predicate: (row: Row) => boolean) => {
            this.pendingWhere = predicate;
            return { limit: async () => this.runSelect() };
          },
        };
      },
    };
  }

  insert(table: unknown) {
    this.pendingTable = table;
    return {
      values: (row: Row) => {
        const persist = (): Row[] => {
          const stamped: Row = { ...row, createdAt: row.createdAt ?? new Date() };
          this.collectionFor(table).push(stamped);
          return [stamped];
        };
        return {
          returning: async () => persist(),
          then: (resolve: (rows: Row[]) => unknown) => resolve(persist()),
        };
      },
    };
  }

  update(table: unknown) {
    this.pendingTable = table;
    return {
      set: (changes: Row) => ({
        where: (predicate: (row: Row) => boolean) => {
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
      }),
    };
  }

  private runSelect(): Row[] {
    const collection = this.collectionFor(this.pendingTable);
    const predicate = this.pendingWhere;
    if (!predicate) return collection.slice(0, 1);
    return collection.filter((row) => predicate(row)).slice(0, 1);
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function seedPublicClient(db: FakeDb): string {
  const clientId = `${OAUTH_CLIENT_ID_PREFIX}public_client`;
  db.clients.push({
    clientId,
    clientSecretHash: null,
    tokenEndpointAuthMethod: "none",
    name: "Claude.ai (public)",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    createdBy: null,
    createdAt: new Date(Date.now() - 60_000),
    revokedAt: null,
  });
  return clientId;
}

function seedConfidentialClient(db: FakeDb, secret: string): string {
  const clientId = `${OAUTH_CLIENT_ID_PREFIX}confidential_client`;
  db.clients.push({
    clientId,
    clientSecretHash: sha256Hex(secret),
    tokenEndpointAuthMethod: "client_secret_post",
    name: "Cursor (confidential)",
    redirectUris: ["https://cursor.sh/oauth/callback"],
    createdBy: null,
    createdAt: new Date(Date.now() - 60_000),
    revokedAt: null,
  });
  return clientId;
}

function seedCode(
  db: FakeDb,
  clientId: string,
  verifier: string,
): string {
  const code = `test-code-${clientId}`;
  db.codes.push({
    code,
    clientId,
    userId: "11111111-1111-4111-8111-111111111111",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: pkceChallengeFromVerifier(verifier),
    codeChallengeMethod: "S256",
    scopes: ["read", "write"],
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    usedAt: null,
    createdAt: new Date(),
  });
  return code;
}

// ── tests: registration ────────────────────────────────────────────────

describe("OauthService.register — public client (method='none')", () => {
  it("registers a public client: no client_secret returned, method echoed", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);

    const result = await svc.register({
      clientName: "Claude.ai browser",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      tokenEndpointAuthMethod: "none",
    });

    expect(result.tokenEndpointAuthMethod).toBe("none");
    expect(result.clientSecret).toBeUndefined();
    expect(result.clientId.startsWith(OAUTH_CLIENT_ID_PREFIX)).toBe(true);

    // The persisted row must have null clientSecretHash.
    expect(db.clients[0].clientSecretHash).toBeNull();
    expect(db.clients[0].tokenEndpointAuthMethod).toBe("none");
  });

  it("registers a confidential client: client_secret present, method='client_secret_post'", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);

    const result = await svc.register({
      clientName: "Cursor IDE",
      redirectUris: ["https://cursor.sh/oauth/callback"],
      tokenEndpointAuthMethod: "client_secret_post",
    });

    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(typeof result.clientSecret).toBe("string");
    expect(result.clientSecret!.length).toBe(64);
    expect(db.clients[0].clientSecretHash).toBe(sha256Hex(result.clientSecret!));
  });

  it("defaults to confidential when no method is specified", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);

    const result = await svc.register({
      redirectUris: ["https://example.com/cb"],
    });

    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(result.clientSecret).toBeTruthy();
  });
});

// ── tests: authorization_code exchange for public client ───────────────

describe("OauthService.exchangeAuthorizationCode — public client", () => {
  it("succeeds with PKCE only (no client_secret)", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const clientId = seedPublicClient(db);
    const verifier = "p".repeat(64);
    const code = seedCode(db, clientId, verifier);

    const result = await svc.exchangeAuthorizationCode({
      code,
      clientId,
      clientSecret: null,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: verifier,
    });

    expect(result.accessToken).toMatch(/^okt_pat_/);
    expect(result.refreshToken).toMatch(/^okt_rt_/);
    expect(result.scopes).toEqual(["read", "write"]);
  });

  it("rejects PKCE verifier mismatch even for public client", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const clientId = seedPublicClient(db);
    const verifier = "p".repeat(64);
    const code = seedCode(db, clientId, verifier);

    await expect(
      svc.exchangeAuthorizationCode({
        code,
        clientId,
        clientSecret: null,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeVerifier: "z".repeat(64), // wrong verifier
      }),
    ).rejects.toMatchObject({ oauthCode: "invalid_grant", message: "PKCE verifier mismatch" });
  });
});

// ── tests: authorization_code exchange for confidential client ─────────

describe("OauthService.exchangeAuthorizationCode — confidential client", () => {
  it("fails with invalid_client when no client_secret is provided", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "cursor-secret";
    const clientId = seedConfidentialClient(db, secret);
    const verifier = "v".repeat(64);

    // Seed a code for the cursor redirect, not claude redirect
    db.codes.push({
      code: `test-code-${clientId}`,
      clientId,
      userId: "22222222-2222-4222-8222-222222222222",
      redirectUri: "https://cursor.sh/oauth/callback",
      codeChallenge: pkceChallengeFromVerifier(verifier),
      codeChallengeMethod: "S256",
      scopes: ["read", "write"],
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
      createdAt: new Date(),
    });

    await expect(
      svc.exchangeAuthorizationCode({
        code: `test-code-${clientId}`,
        clientId,
        clientSecret: null, // omitted — should fail
        redirectUri: "https://cursor.sh/oauth/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({
      oauthCode: "invalid_client",
      message: "client_secret required for confidential client",
    });
  });

  it("succeeds when client_secret is correct", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const secret = "cursor-secret-ok";
    const clientId = seedConfidentialClient(db, secret);
    const verifier = "v".repeat(64);

    db.codes.push({
      code: `test-code-${clientId}`,
      clientId,
      userId: "22222222-2222-4222-8222-222222222222",
      redirectUri: "https://cursor.sh/oauth/callback",
      codeChallenge: pkceChallengeFromVerifier(verifier),
      codeChallengeMethod: "S256",
      scopes: ["read", "write"],
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      usedAt: null,
      createdAt: new Date(),
    });

    const result = await svc.exchangeAuthorizationCode({
      code: `test-code-${clientId}`,
      clientId,
      clientSecret: secret,
      redirectUri: "https://cursor.sh/oauth/callback",
      codeVerifier: verifier,
    });

    expect(result.accessToken).toMatch(/^okt_pat_/);
  });
});

// ── tests: refresh_token for public client ─────────────────────────────

describe("OauthService.refreshTokens — public client", () => {
  it("rotates tokens without a client_secret", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const clientId = seedPublicClient(db);

    const oldRefresh = "okt_rt_" + "a".repeat(64);
    db.tokens.push({
      id: "tok-pub-1",
      userId: "33333333-3333-4333-8333-333333333333",
      name: `oauth:${clientId}`,
      tokenHash: "old-hash",
      prefix: "okt_pat_old",
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
      clientSecret: null,
    });

    expect(result.accessToken).toMatch(/^okt_pat_/);
    expect(result.refreshToken).not.toBe(oldRefresh);

    // Old token should be revoked.
    const old = db.tokens.find((t) => t.id === "tok-pub-1")!;
    expect(old.revokedAt).toBeTruthy();
  });
});
