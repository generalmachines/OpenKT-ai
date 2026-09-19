/**
 * OAuth sign-in for MCP clients, end to end, with the server's own sign-in
 * page (no dashboard): the REAL AppModule booted with NO SUPABASE_* variables
 * against a real Postgres (`describeIfDb` — skipped when DATABASE_URL is unset).
 *
 * The round trip every connector (claude.ai, Cowork, ChatGPT, Codex) makes:
 *   DCR → GET /oauth/authorize (HTML page) → POST credentials (form) → 302 with
 *   code → POST /oauth/token with the PKCE S256 verifier → /mcp tools/list and
 *   /v1/me with the issued token.
 * Plus: sign-up through the page, wrong password, CSRF token missing / forged /
 * bound to other params / without its cookie, Cancel, unknown client, and
 * /oauth/consent with an okt_pat_ session token.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";

import { enableCorsFromEnv } from "@openkt/platform-cors";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const PASSWORD = "quiet-Harbor-58";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@oauth.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function bootApp(): Promise<NestExpressApplication> {
  for (const key of SUPABASE_KEYS) delete process.env[key];
  const { AppModule } = await import("../../apps/server/src/app.module");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.set("trust proxy", true);
  // Same prefix exclusions and CORS as main.ts.
  const { UNPREFIXED_ROUTES } = await import("../../apps/server/src/app.module");
  app.setGlobalPrefix("v1", { exclude: [...UNPREFIXED_ROUTES] });
  enableCorsFromEnv(app, { env: { CORS_ALLOWED_ORIGINS: "https://app.example.test" } });
  await app.init();
  return app;
}

describeIfDb("OAuth sign-in page for MCP clients (e2e, no Supabase configured)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());

  async function registerClient(redirectUri = CLAUDE_CALLBACK, name = "Claude") {
    const res = await http()
      .post("/oauth/register")
      .set("X-Forwarded-For", freshIp())
      .send({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
      .expect(201);
    expect(res.body.client_secret).toBeUndefined();
    return res.body.client_id as string;
  }

  function authorizeQuery(clientId: string, challenge: string, redirectUri = CLAUDE_CALLBACK, state = `st-${randomUUID()}`) {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "read write",
      resource: "http://127.0.0.1/mcp",
    };
  }

  // GET the page; return the hidden form fields and the CSRF cookie.
  async function openPage(query: Record<string, string>, ip = freshIp()) {
    const res = await http().get("/oauth/authorize").query(query).set("X-Forwarded-For", ip).expect(200);
    const html = res.text;
    const fields: Record<string, string> = {};
    for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      fields[m[1]!] = decodeEntities(m[2]!);
    }
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const cookie = setCookie.find((c) => c.startsWith("okt_oauth_form="))?.split(";")[0] ?? "";
    return { res, html, fields, cookie };
  }

  function submit(fields: Record<string, string>, cookie: string | null, ip = freshIp()) {
    const req = http().post("/oauth/authorize").type("form").set("X-Forwarded-For", ip);
    if (cookie) req.set("Cookie", cookie);
    return req.send(fields);
  }

  function exchange(clientId: string, code: string, verifier: string, redirectUri = CLAUDE_CALLBACK) {
    return http()
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
  }

  function mcp(token: string, body: unknown) {
    return http()
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send(body as object);
  }

  beforeAll(async () => {
    for (const key of [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE"]) savedEnv[key] = process.env[key];
    process.env.OPENKT_MEMORY_ENGINE = "local";
    pool = new Pool({ connectionString: DATABASE_URL });
    app = await bootApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool.query(`delete from login_attempts where email like $1`, [`%-${run}-%@oauth.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("discovery points at the server's own authorize, token and register endpoints", async () => {
    const res = await http().get("/.well-known/oauth-authorization-server").expect(200);
    expect(res.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(res.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(res.body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("accepts the redirect URIs claude.ai, ChatGPT, Codex and Cursor register", async () => {
    for (const uri of [
      CLAUDE_CALLBACK,
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://127.0.0.1:1455/auth/callback",
      "http://localhost:33418/callback",
      "cursor://anysphere.cursor-retrieval/oauth/user-openkt/callback",
    ]) {
      await registerClient(uri, "client");
    }
  });

  it("full round trip: sign up on the page → code → token (PKCE S256) → tools/list and /v1/me", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(clientId, challenge);
    const email = freshEmail("round");

    const page = await openPage(query);
    expect(page.res.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.res.headers["cache-control"]).toBe("no-store");
    expect(page.html).toContain("Claude</span> wants to use your OpenKT context");
    expect(page.html).toContain("Create an account");
    expect(page.html).toContain("claude.ai");
    expect(page.html).not.toMatch(/<script/i);
    expect(page.cookie).toMatch(/^okt_oauth_form=.+/);
    expect(page.fields.form_token).toBeTruthy();

    const res = await submit(
      { ...page.fields, mode: "signup", action: "allow", display_name: "Round Trip", email, password: PASSWORD },
      page.cookie,
    ).expect(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get("state")).toBe(query.state);
    const code = location.searchParams.get("code");
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    // A wrong verifier is refused; the right one is accepted once.
    await exchange(clientId, code!, pkce().verifier).expect(400);
    const token = await exchange(clientId, code!, verifier).expect(200);
    expect(token.body).toEqual({
      access_token: expect.stringMatching(/^okt_pat_[0-9a-f]{64}$/),
      token_type: "Bearer",
      expires_in: expect.any(Number),
      refresh_token: expect.stringMatching(/^okt_rt_/),
      scope: "read write",
    });
    await exchange(clientId, code!, verifier).expect(400); // single use

    const accessToken = token.body.access_token as string;
    const init = await mcp(accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    }).expect(200);
    expect(init.body.result.serverInfo.name).toBe("openkt");
    const list = await mcp(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }).expect(200);
    const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["kt_session_start", "kt_recall", "kt_save_memory", "kt_session_end"]));

    const me = await http().get("/v1/me").set("Authorization", `Bearer ${accessToken}`).expect(200);
    expect(me.body.data.email).toBe(email);

    // The refresh token rotates into a working pair.
    const refreshed = await http()
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: token.body.refresh_token, client_id: clientId })
      .expect(200);
    await mcp(refreshed.body.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }).expect(200);
  });

  it("signs in an existing account on the page", async () => {
    const email = freshEmail("existing");
    await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: "Existing Person" })
      .expect(201);

    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const page = await openPage(authorizeQuery(clientId, challenge));
    const res = await submit({ ...page.fields, mode: "signin", action: "allow", email: email.toUpperCase(), password: PASSWORD }, page.cookie).expect(302);
    const code = new URL(res.headers.location as string).searchParams.get("code")!;
    const token = await exchange(clientId, code, verifier).expect(200);
    const me = await http().get("/v1/me").set("Authorization", `Bearer ${token.body.access_token}`).expect(200);
    expect(me.body.data.email).toBe(email);
  });

  it("wrong password: the page again with one generic message, no code", async () => {
    const email = freshEmail("wrongpw");
    await http().post("/v1/auth/signup").set("X-Forwarded-For", freshIp()).send({ email, password: PASSWORD, display_name: "W" }).expect(201);
    const clientId = await registerClient();
    const page = await openPage(authorizeQuery(clientId, pkce().challenge));

    const res = await submit({ ...page.fields, mode: "signin", email, password: "not-the-password-1" }, page.cookie).expect(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain("That email and password do not match an OpenKT account.");
    expect(res.text).toContain(`value="${email}"`); // email kept, password not
    // An unknown email reads exactly the same.
    const page2 = await openPage(authorizeQuery(clientId, pkce().challenge));
    const unknown = await submit({ ...page2.fields, mode: "signin", email: freshEmail("nobody"), password: "not-the-password-1" }, page2.cookie).expect(401);
    expect(unknown.text).toContain("That email and password do not match an OpenKT account.");
  });

  it("sign-up through the page follows the signup rules (weak password, taken email, name required)", async () => {
    const clientId = await registerClient();
    const taken = freshEmail("taken");
    await http().post("/v1/auth/signup").set("X-Forwarded-For", freshIp()).send({ email: taken, password: PASSWORD, display_name: "T" }).expect(201);

    let page = await openPage(authorizeQuery(clientId, pkce().challenge));
    const weak = await submit({ ...page.fields, mode: "signup", display_name: "W", email: freshEmail("weak"), password: "short" }, page.cookie).expect(400);
    expect(weak.text).toContain("Password must be at least 10 characters.");

    page = await openPage(authorizeQuery(clientId, pkce().challenge));
    const dup = await submit({ ...page.fields, mode: "signup", display_name: "D", email: taken, password: PASSWORD }, page.cookie).expect(409);
    expect(dup.text).toContain("already exists");

    page = await openPage(authorizeQuery(clientId, pkce().challenge));
    const noName = await submit({ ...page.fields, mode: "signup", email: freshEmail("noname"), password: PASSWORD }, page.cookie).expect(400);
    expect(noName.text).toContain("Enter your name");
  });

  describe("CSRF", () => {
    let clientId: string;
    let email: string;
    beforeAll(async () => {
      clientId = await registerClient();
      email = freshEmail("csrf");
      await http().post("/v1/auth/signup").set("X-Forwarded-For", freshIp()).send({ email, password: PASSWORD, display_name: "C" }).expect(201);
    });

    it("refuses a post without a form token", async () => {
      const page = await openPage(authorizeQuery(clientId, pkce().challenge));
      const { form_token: _drop, ...rest } = page.fields;
      const res = await submit({ ...rest, email, password: PASSWORD }, page.cookie).expect(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain("expired");
    });

    it("refuses a forged or tampered token", async () => {
      const page = await openPage(authorizeQuery(clientId, pkce().challenge));
      const [body, sig] = page.fields.form_token!.split(".");
      await submit({ ...page.fields, form_token: `${body}.${sig!.slice(0, -2)}xx`, email, password: PASSWORD }, page.cookie).expect(400);
      await submit({ ...page.fields, form_token: "garbage", email, password: PASSWORD }, page.cookie).expect(400);
    });

    it("refuses a token minted for other authorize params", async () => {
      const a = await openPage(authorizeQuery(clientId, pkce().challenge));
      const b = await openPage(authorizeQuery(clientId, pkce().challenge));
      // b's page fields (its challenge and state) with a's token and cookie.
      const res = await submit({ ...b.fields, form_token: a.fields.form_token!, email, password: PASSWORD }, a.cookie).expect(400);
      expect(res.headers.location).toBeUndefined();
    });

    it("refuses a post without the page's cookie (a cross-site form post)", async () => {
      const page = await openPage(authorizeQuery(clientId, pkce().challenge));
      await submit({ ...page.fields, email, password: PASSWORD }, null).expect(400);
      const other = await openPage(authorizeQuery(clientId, pkce().challenge));
      await submit({ ...page.fields, email, password: PASSWORD }, other.cookie).expect(400);
    });

    it("the same post with token and cookie goes through", async () => {
      const page = await openPage(authorizeQuery(clientId, pkce().challenge));
      await submit({ ...page.fields, email, password: PASSWORD }, page.cookie).expect(302);
    });
  });

  it("Cancel sends access_denied back to the client with its state", async () => {
    const clientId = await registerClient();
    const query = authorizeQuery(clientId, pkce().challenge);
    const page = await openPage(query);
    const res = await submit({ ...page.fields, action: "deny" }, page.cookie).expect(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(query.state);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("an unknown client or an unregistered redirect_uri is an error page, never a redirect", async () => {
    const unknown = await http().get("/oauth/authorize").query(authorizeQuery("okt_oauth_nope", pkce().challenge)).expect(400);
    expect(unknown.headers.location).toBeUndefined();
    expect(unknown.headers["content-type"]).toMatch(/^text\/html/);
    expect(unknown.text).toContain("not registered");

    const clientId = await registerClient();
    const wrongRedirect = await http()
      .get("/oauth/authorize")
      .query(authorizeQuery(clientId, pkce().challenge, "https://evil.example/cb"))
      .expect(400);
    expect(wrongRedirect.headers.location).toBeUndefined();

    // A bad PKCE method with a valid client + redirect goes back as ?error=.
    const plain = await http()
      .get("/oauth/authorize")
      .query({ ...authorizeQuery(clientId, pkce().challenge), code_challenge_method: "plain" })
      .expect(302);
    expect(new URL(plain.headers.location as string).searchParams.get("error")).toBe("invalid_request");
  });

  it("escapes a hostile client_name", async () => {
    const clientId = await registerClient(CLAUDE_CALLBACK, `<script>alert(1)</script>"><img src=x>`);
    const page = await openPage(authorizeQuery(clientId, pkce().challenge));
    expect(page.html).not.toContain("<script>alert(1)</script>");
    expect(page.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  describe("what real connectors send (claude.ai, ChatGPT, Codex, browser clients)", () => {
    it("RFC 9728 path-suffixed metadata, OIDC discovery path, Basic auth advertised", async () => {
      const suffixed = await http().get("/.well-known/oauth-protected-resource/mcp").expect(200);
      expect(suffixed.body.resource).toMatch(/\/mcp$/);
      const legacy = await http().get("/.well-known/oauth-protected-resource/v1/mcp").expect(200);
      expect(legacy.body.resource).toMatch(/\/v1\/mcp$/);
      await http().get("/.well-known/oauth-protected-resource/other").expect(404);
      const oidc = await http().get("/.well-known/openid-configuration").expect(200);
      const as = await http().get("/.well-known/oauth-authorization-server").expect(200);
      expect(Object.keys(oidc.body).sort()).toEqual(Object.keys(as.body).sort());
      expect(oidc.body.token_endpoint).toMatch(/\/oauth\/token$/);
      expect(as.body.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_post", "client_secret_basic"]);
    });

    it("DCR: claude.ai's confidential body gets client_secret_expires_at; unknown methods are invalid_client_metadata", async () => {
      const claude = await http()
        .post("/oauth/register")
        .set("X-Forwarded-For", freshIp())
        .send({
          client_name: "Claude",
          redirect_uris: [CLAUDE_CALLBACK, "https://claude.com/api/mcp/auth_callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
          scope: "read write",
        })
        .expect(201);
      expect(claude.body).toMatchObject({ client_secret: expect.any(String), client_secret_expires_at: 0, scope: "read write" });
      const bad = await http()
        .post("/oauth/register")
        .set("X-Forwarded-For", freshIp())
        .send({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "private_key_jwt" })
        .expect(400);
      expect(bad.body.error).toBe("invalid_client_metadata");
    });

    it("client_secret_basic: register, sign in, exchange with Authorization: Basic; no-store on the token response", async () => {
      const reg = await http()
        .post("/oauth/register")
        .set("X-Forwarded-For", freshIp())
        .send({ client_name: "Basic", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_basic" })
        .expect(201);
      expect(reg.body.token_endpoint_auth_method).toBe("client_secret_basic");
      const email = freshEmail("basic");
      await http().post("/v1/auth/signup").set("X-Forwarded-For", freshIp()).send({ email, password: PASSWORD, display_name: "B" }).expect(201);
      const { verifier, challenge } = pkce();
      const page = await openPage(authorizeQuery(reg.body.client_id, challenge));
      const res = await submit({ ...page.fields, email, password: PASSWORD }, page.cookie).expect(302);
      const code = new URL(res.headers.location as string).searchParams.get("code")!;
      const basic = Buffer.from(`${encodeURIComponent(reg.body.client_id)}:${encodeURIComponent(reg.body.client_secret)}`).toString("base64");
      // Without the secret: refused.
      await http().post("/oauth/token").type("form")
        .send({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, client_id: reg.body.client_id, code_verifier: verifier })
        .expect(401);
      const token = await http()
        .post("/oauth/token")
        .set("Authorization", `Basic ${basic}`)
        .type("form")
        .send({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, resource: "http://127.0.0.1/mcp" })
        .expect(200);
      expect(token.headers["cache-control"]).toBe("no-store");
      expect(token.body.access_token).toMatch(/^okt_pat_/);
      const refreshed = await http()
        .post("/oauth/token")
        .set("Authorization", `Basic ${basic}`)
        .type("form")
        .send({ grant_type: "refresh_token", refresh_token: token.body.refresh_token })
        .expect(200);
      expect(refreshed.body.access_token).toMatch(/^okt_pat_/);
    });

    it("GET /mcp is 405 (no SSE stream); DELETE ends nothing and succeeds; /v1/mcp is an alias", async () => {
      const email = freshEmail("transport");
      const session = await http().post("/v1/auth/signup").set("X-Forwarded-For", freshIp()).send({ email, password: PASSWORD, display_name: "T" }).expect(201);
      const token = session.body.data.token as string;
      const get = await http().get("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", "text/event-stream").expect(405);
      expect(get.headers.allow).toBe("POST, DELETE");
      await http().delete("/mcp").set("Authorization", `Bearer ${token}`).expect(200);
      const alias = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
      expect(alias.body.result.tools.length).toBeGreaterThan(5);
      const v1 = await http()
        .post("/v1/mcp")
        .set("Authorization", `Bearer ${token}`)
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        .expect(200);
      expect(v1.body.result.tools.length).toBe(alias.body.result.tools.length);
      const unauth = await http().post("/v1/mcp").send({}).expect(401);
      expect(unauth.headers["www-authenticate"]).toMatch(/oauth-protected-resource\/v1\/mcp"/);
    });

    it("CORS: any origin may call /mcp and the OAuth endpoints (no credentials); MCP headers allowed and exposed", async () => {
      const pre = await http()
        .options("/mcp")
        .set("Origin", "https://claude.ai")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id")
        .expect(204);
      expect(pre.headers["access-control-allow-origin"]).toBe("*");
      expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
      for (const h of ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id"]) {
        expect(pre.headers["access-control-allow-headers"].toLowerCase()).toContain(h);
      }
      const unauth = await http().post("/mcp").set("Origin", "https://chatgpt.com").send({}).expect(401);
      expect(unauth.headers["access-control-allow-origin"]).toBe("*");
      expect(unauth.headers["access-control-expose-headers"]).toMatch(/WWW-Authenticate/);
      expect(unauth.headers["access-control-expose-headers"]).toMatch(/Mcp-Session-Id/);
      for (const path of ["/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await http().options(path).set("Origin", "https://claude.ai").set("Access-Control-Request-Method", "POST").expect(204);
        expect(res.headers["access-control-allow-origin"]).toBe("*");
      }
      // The REST API keeps its allow-list with credentials; the sign-in page gets no CORS at all.
      const rest = await http().options("/v1/me").set("Origin", "https://claude.ai").set("Access-Control-Request-Method", "GET");
      expect(rest.headers["access-control-allow-origin"]).toBeUndefined();
      const ok = await http().options("/v1/me").set("Origin", "https://app.example.test").set("Access-Control-Request-Method", "GET").expect(204);
      expect(ok.headers["access-control-allow-credentials"]).toBe("true");
      const page = await http().options("/oauth/authorize").set("Origin", "https://claude.ai").set("Access-Control-Request-Method", "POST");
      expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  it("/oauth/consent accepts an okt_pat_ session token (the optional dashboard path)", async () => {
    const email = freshEmail("consent");
    const session = await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: "Consent" })
      .expect(201);
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const res = await http()
      .post("/oauth/consent")
      .set("Authorization", `Bearer ${session.body.data.token}`)
      .send({ client_id: clientId, redirect_uri: CLAUDE_CALLBACK, state: "s1", code_challenge: challenge, code_challenge_method: "S256" })
      .expect(200);
    const url = new URL(res.body.data.redirect_url as string);
    const token = await exchange(clientId, url.searchParams.get("code")!, verifier).expect(200);
    await mcp(token.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(200);
    await http().post("/oauth/consent").send({ client_id: clientId }).expect(401);
  });
});

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
