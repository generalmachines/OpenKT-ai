// Unit tests for the RFC 7591 dynamic client registration path.
//
// Covers:
//   * assertValidRedirectUri — rejects non-https URIs (except localhost
//     http per RFC 8252 §7.3), accepts https://…
//   * OauthService.register happy path returns RFC 7591 §3.2.1 fields:
//     client_id (okt_oauth_…), client_secret, client_id_issued_at,
//     redirect_uris, name.

import {
  OauthError,
  OauthService,
  assertValidRedirectUri,
  sha256Hex,
  OAUTH_CLIENT_ID_PREFIX,
} from "../../apps/server/src/modules/oauth/services/oauth.service";

import {
  oauthAuthorizationCodes,
  oauthClients,
  personalAccessTokens,
} from "../../apps/server/src/db/schema";

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
  const and = (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) => preds.every((p) => p(row));
  const sql = Object.assign(() => "<<sql>>", { raw: () => "<<sql>>" });
  return { ...actual, eq, isNull, and, sql };
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
    throw new Error("unknown table");
  }

  insert(table: unknown) {
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
}

describe("assertValidRedirectUri", () => {
  it("accepts https://… URIs", () => {
    expect(() => assertValidRedirectUri("https://claude.ai/cb")).not.toThrow();
    expect(() => assertValidRedirectUri("https://example.com/oauth/callback?x=1")).not.toThrow();
  });

  it("accepts http://localhost variants for native dev", () => {
    expect(() => assertValidRedirectUri("http://localhost/cb")).not.toThrow();
    expect(() => assertValidRedirectUri("http://localhost:7000/cb")).not.toThrow();
    expect(() => assertValidRedirectUri("http://127.0.0.1:8080/cb")).not.toThrow();
    expect(() => assertValidRedirectUri("http://[::1]/cb")).not.toThrow();
  });

  it("rejects http://… for non-localhost hosts", () => {
    expect(() => assertValidRedirectUri("http://example.com/cb")).toThrow(OauthError);
    try {
      assertValidRedirectUri("http://example.com/cb");
    } catch (e) {
      expect((e as OauthError).oauthCode).toBe("invalid_redirect_uri");
    }
  });

  it("rejects garbage URIs and explicitly banned schemes", () => {
    expect(() => assertValidRedirectUri("not-a-url")).toThrow(OauthError);
    // javascript:, data:, file: are explicitly denied by the service.
    expect(() => assertValidRedirectUri("javascript:alert(1)")).toThrow(OauthError);
    expect(() => assertValidRedirectUri("data:text/html,<h1>")).toThrow(OauthError);
    expect(() => assertValidRedirectUri("file:///etc/passwd")).toThrow(OauthError);
  });

  it("accepts private-use URI schemes for native app clients (RFC 8252 §7.1)", () => {
    // The service allows any non-http(s) scheme that matches the URI
    // scheme ABNF — this covers native MCP clients like cursor, vscode,
    // ftp, etc. The security boundary is the registered redirect_uri
    // list, not the scheme.
    expect(() => assertValidRedirectUri("ftp://example.com/cb")).not.toThrow();
    expect(() => assertValidRedirectUri("cursor://mcp/auth")).not.toThrow();
    expect(() => assertValidRedirectUri("vscode://callback")).not.toThrow();
  });
});

describe("OauthService.register", () => {
  it("mints client_id (okt_oauth_…) + client_secret in RFC 7591 shape", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const result = await svc.register({
      clientName: "Claude.ai web",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    // Default registration is a confidential client — clientSecret is present.
    expect(result.clientId.startsWith(OAUTH_CLIENT_ID_PREFIX)).toBe(true);
    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(result.clientSecret).toMatch(/^[0-9a-f]+$/);
    expect(result.clientSecret!.length).toBe(64); // 32 bytes hex
    expect(result.redirectUris).toEqual([
      "https://claude.ai/api/mcp/auth_callback",
    ]);
    expect(typeof result.clientIdIssuedAt).toBe("number");
    expect(result.clientIdIssuedAt).toBeGreaterThan(0);
    expect(result.name).toBe("Claude.ai web");

    // Row was persisted with a hashed secret — the raw value never
    // touches the table.
    expect(db.clients).toHaveLength(1);
    expect(db.clients[0].clientId).toBe(result.clientId);
    expect(db.clients[0].clientSecretHash).toBe(sha256Hex(result.clientSecret!));
    expect(db.clients[0].clientSecretHash).not.toBe(result.clientSecret);
  });

  it("defaults the client name when none is provided", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const result = await svc.register({
      redirectUris: ["https://example.com/cb"],
    });
    expect(result.name.length).toBeGreaterThan(0);
  });

  it("rejects empty redirect_uris", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    await expect(
      svc.register({ redirectUris: [], clientName: "x" }),
    ).rejects.toMatchObject({ oauthCode: "invalid_redirect_uri" });
  });

  it("rejects an http://example.com redirect_uri", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    await expect(
      svc.register({
        redirectUris: ["http://malicious.example.com/cb"],
      }),
    ).rejects.toMatchObject({ oauthCode: "invalid_redirect_uri" });
  });

  it("accepts http://localhost redirect_uris", async () => {
    const db = new FakeDb();
    const svc = new OauthService(db as never);
    const result = await svc.register({
      redirectUris: ["http://localhost:7000/cb"],
    });
    expect(result.clientId.startsWith(OAUTH_CLIENT_ID_PREFIX)).toBe(true);
  });
});
