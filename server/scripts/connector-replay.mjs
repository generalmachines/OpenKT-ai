#!/usr/bin/env node
// Replays, request by request, what claude.ai / Cowork, ChatGPT, Codex and browser-based MCP clients send when
// someone adds OpenKT as a custom connector — discovery, Dynamic Client Registration, the sign-in page, the
// token exchange, refresh, the MCP session and CORS — and prints PASS / FAIL per step.
//
//   node server/scripts/connector-replay.mjs                         # against https://mcp.openkt.ai
//   node server/scripts/connector-replay.mjs http://127.0.0.1:4100   # against a local server
//
// Sign-in: OPENKT_REPLAY_EMAIL + OPENKT_REPLAY_PASSWORD sign in an existing account; without them the script
// creates a throwaway account through the sign-in page ("Create an account").
//
// Sources for the request shapes (checked 2026-09-19):
//   MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
//     (401 + WWW-Authenticate resource_metadata, RFC 9728 path-suffixed metadata, RFC 8414 / OIDC discovery,
//      DCR RFC 7591, PKCE S256, RFC 8707 `resource` on authorize and token)
//   Streamable HTTP: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//     (Accept: application/json, text/event-stream; Mcp-Session-Id; MCP-Protocol-Version; GET → SSE or 405)
//   claude.ai callback: https://claude.ai/api/mcp/auth_callback (and claude.com); ChatGPT:
//     https://chatgpt.com/connector_platform_oauth_redirect; Codex: loopback http://127.0.0.1:<port>/callback/…
// Exit code 1 when any step fails.
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] || process.env.OPENKT_MCP_BASE || "https://mcp.openkt.ai").replace(/\/+$/, "");
const MCP_URL = `${BASE}/mcp`;
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_COM_CB = "https://claude.com/api/mcp/auth_callback";
const CHATGPT_CB = "https://chatgpt.com/connector_platform_oauth_redirect";
const CODEX_CB = "http://127.0.0.1:1455/callback/replay";
const ACCEPT = "application/json, text/event-stream";
const UI_CAPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

const results = [];
const ctx = {};

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name });
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (err) {
    results.push({ ok: false, name });
    console.log(`FAIL  ${name}  — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
const b64url = (buf) => Buffer.from(buf).toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 160)}`);
  }
}
// A Streamable HTTP response may be JSON or one SSE event.
async function rpcBody(res) {
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}
function form(obj) {
  return new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined));
}
function cookieFrom(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return all.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}
function hiddenFields(html) {
  const fields = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return fields;
}

// The browser half of the flow: open the page, sign in (or sign up), follow the 302 to the client's callback.
async function signIn(clientId, redirectUri, challenge, state) {
  const query = form({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "read write",
    resource: MCP_URL,
  });
  const page = await fetch(`${BASE}/oauth/authorize?${query}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 replay" } });
  expect(page.status === 200, `GET /oauth/authorize → ${page.status}`);
  const html = await page.text();
  const fields = hiddenFields(html);
  expect(fields.form_token, "sign-in page has no form_token");
  const creds = ctx.account.existing
    ? { mode: "signin", email: ctx.account.email, password: ctx.account.password }
    : { mode: "signup", email: ctx.account.email, password: ctx.account.password, display_name: "Connector Replay" };
  const post = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieFrom(page), origin: BASE, "user-agent": "Mozilla/5.0 replay" },
    body: form({ ...fields, ...creds, action: "allow" }),
  });
  if (post.status !== 302) {
    const body = await post.text();
    const err = body.match(/class="error"[^>]*>([^<]*)</);
    throw new Error(`POST /oauth/authorize → ${post.status}${err ? ` "${err[1]}"` : ""}`);
  }
  ctx.account.existing = true; // signed up once; sign in from now on
  const location = new URL(post.headers.get("location"));
  expect(`${location.origin}${location.pathname}` === redirectUri, `redirected to ${location.origin}${location.pathname}`);
  expect(location.searchParams.get("state") === state, "state not echoed");
  const code = location.searchParams.get("code");
  expect(code, "no code in the redirect");
  return { code, html };
}

async function tokenRequest(params, basic) {
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString("base64")}`;
  return fetch(`${BASE}/oauth/token`, { method: "POST", headers, body: form(params) });
}

async function register(body) {
  const res = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await json(res);
  expect(res.status === 201, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

function mcp(token, message, extraHeaders = {}) {
  return fetch(MCP_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: ACCEPT, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(message),
  });
}

async function main() {
  console.log(`Connector replay against ${BASE}  (MCP ${MCP_URL})\n`);
  const email = process.env.OPENKT_REPLAY_EMAIL;
  ctx.account = email
    ? { email, password: process.env.OPENKT_REPLAY_PASSWORD, existing: true }
    : { email: `connector-replay-${Date.now()}@e2e.openkt.test`, password: `replay-${b64url(randomBytes(12))}`, existing: false };

  // ── 1. discovery ────────────────────────────────────────────────────
  await step("POST /mcp without a token → 401 + WWW-Authenticate resource_metadata", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1.0" } } }),
    });
    expect(res.status === 401, `HTTP ${res.status}`);
    const header = res.headers.get("www-authenticate") || "";
    const m = header.match(/resource_metadata="([^"]+)"/);
    expect(m, `WWW-Authenticate: ${header || "(missing)"}`);
    ctx.prmUrl = m[1];
    return header;
  });

  await step("GET resource_metadata URL from the header (RFC 9728)", async () => {
    const res = await fetch(ctx.prmUrl || `${BASE}/.well-known/oauth-protected-resource`);
    const prm = await json(res);
    expect(res.status === 200, `HTTP ${res.status}`);
    expect(prm.resource === MCP_URL, `resource ${prm.resource} ≠ ${MCP_URL}`);
    expect(Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0, "no authorization_servers");
    ctx.issuer = prm.authorization_servers[0];
    return `resource=${prm.resource} as=${ctx.issuer}`;
  });

  await step("GET /.well-known/oauth-protected-resource/mcp (path-suffixed, RFC 9728 §3.1)", async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    const prm = await json(res);
    expect(res.status === 200, `HTTP ${res.status}`);
    expect(prm.resource === MCP_URL, `resource ${prm.resource}`);
  });

  await step("GET /.well-known/oauth-authorization-server (RFC 8414)", async () => {
    const issuer = (ctx.issuer || BASE).replace(/\/+$/, "");
    const res = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    const as = await json(res);
    expect(res.status === 200, `HTTP ${res.status}`);
    expect(as.issuer === issuer, `issuer ${as.issuer} ≠ ${issuer}`);
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) expect(as[k], `missing ${k}`);
    expect(as.code_challenge_methods_supported?.includes("S256"), "S256 not advertised");
    expect(as.grant_types_supported?.includes("refresh_token"), "refresh_token not advertised");
    for (const m of ["none", "client_secret_post", "client_secret_basic"]) {
      expect(as.token_endpoint_auth_methods_supported?.includes(m), `token_endpoint_auth_methods_supported lacks ${m}`);
    }
    ctx.as = as;
    return `auth methods ${as.token_endpoint_auth_methods_supported.join(",")}`;
  });

  await step("GET /.well-known/openid-configuration (clients that try OIDC discovery)", async () => {
    const res = await fetch(`${BASE}/.well-known/openid-configuration`);
    const doc = await json(res);
    expect(res.status === 200, `HTTP ${res.status}`);
    expect(doc.issuer && doc.authorization_endpoint && doc.token_endpoint, "incomplete document");
  });

  // ── 2. Dynamic Client Registration, as each client sends it ────────
  await step("DCR as claude.ai (client_secret_post, claude.ai + claude.com callbacks)", async () => {
    const c = await register({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CB, CLAUDE_COM_CB],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "read write",
    });
    expect(c.client_secret, "no client_secret for a confidential client");
    expect("client_secret_expires_at" in c, "client_secret_expires_at missing (RFC 7591 §3.2.1: REQUIRED with a secret)");
    expect(c.redirect_uris?.includes(CLAUDE_COM_CB), "claude.com callback not kept");
    ctx.claude = c;
    return c.client_id.slice(0, 18) + "…";
  });

  await step("DCR as ChatGPT (public client, token_endpoint_auth_method none)", async () => {
    const c = await register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_CB],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(!c.client_secret, "a public client got a secret");
    ctx.chatgpt = c;
  });

  await step("DCR with client_secret_basic", async () => {
    const c = await register({
      client_name: "Basic client",
      redirect_uris: [CHATGPT_CB],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(c.client_secret && c.token_endpoint_auth_method === "client_secret_basic", `got ${c.token_endpoint_auth_method}`);
    ctx.basic = c;
  });

  await step("DCR as Codex (loopback redirect, public)", async () => {
    ctx.codex = await register({ client_name: "Codex", redirect_uris: [CODEX_CB], token_endpoint_auth_method: "none" });
  });

  // ── 3. authorize + token ────────────────────────────────────────────
  await step("claude.ai: sign-in page → form POST → 302 to the callback with code + state", async () => {
    expect(ctx.claude, "no client");
    ctx.claudePkce = pkce();
    const { code, html } = await signIn(ctx.claude.client_id, CLAUDE_CB, ctx.claudePkce.challenge, `st-${Date.now()}`);
    expect(/Claude<\/span> wants to use your OpenKT context/.test(html), "page does not name the client");
    ctx.claudeCode = code;
    return ctx.account.email;
  });

  await step("claude.ai: token exchange (form-encoded, client_secret_post, PKCE S256, resource)", async () => {
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: ctx.claudeCode,
      redirect_uri: CLAUDE_CB,
      client_id: ctx.claude.client_id,
      client_secret: ctx.claude.client_secret,
      code_verifier: ctx.claudePkce.verifier,
      resource: MCP_URL,
    });
    const tok = await json(res);
    expect(res.status === 200, `HTTP ${res.status} ${JSON.stringify(tok)}`);
    expect(tok.token_type === "Bearer" && tok.access_token && tok.refresh_token, "incomplete token response");
    expect((res.headers.get("cache-control") || "").includes("no-store"), "token response without Cache-Control: no-store");
    ctx.token = tok.access_token;
    ctx.refresh = tok.refresh_token;
    return `expires_in=${tok.expires_in} scope="${tok.scope}"`;
  });

  await step("claude.com callback: same client, the other registered redirect_uri", async () => {
    const p = pkce();
    const { code } = await signIn(ctx.claude.client_id, CLAUDE_COM_CB, p.challenge, `st-com-${Date.now()}`);
    const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_COM_CB, client_id: ctx.claude.client_id, client_secret: ctx.claude.client_secret, code_verifier: p.verifier });
    expect(res.status === 200, `HTTP ${res.status} ${await res.text()}`);
  });

  await step("ChatGPT: sign-in → token exchange as a public client (PKCE only)", async () => {
    const p = pkce();
    const { code } = await signIn(ctx.chatgpt.client_id, CHATGPT_CB, p.challenge, `st-gpt-${Date.now()}`);
    const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: CHATGPT_CB, client_id: ctx.chatgpt.client_id, code_verifier: p.verifier, resource: MCP_URL });
    const tok = await json(res);
    expect(res.status === 200, `HTTP ${res.status} ${JSON.stringify(tok)}`);
    ctx.chatgptToken = tok.access_token;
  });

  await step("client_secret_basic: token exchange with Authorization: Basic", async () => {
    const p = pkce();
    const { code } = await signIn(ctx.basic.client_id, CHATGPT_CB, p.challenge, `st-basic-${Date.now()}`);
    const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: CHATGPT_CB, code_verifier: p.verifier }, { id: ctx.basic.client_id, secret: ctx.basic.client_secret });
    expect(res.status === 200, `HTTP ${res.status} ${await res.text()}`);
  });

  await step("Codex: sign-in → loopback callback → token", async () => {
    const p = pkce();
    const { code } = await signIn(ctx.codex.client_id, CODEX_CB, p.challenge, `st-codex-${Date.now()}`);
    const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: CODEX_CB, client_id: ctx.codex.client_id, code_verifier: p.verifier });
    expect(res.status === 200, `HTTP ${res.status} ${await res.text()}`);
  });

  await step("refresh_token grant (form-encoded) rotates; the old refresh token is refused", async () => {
    const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: ctx.refresh, client_id: ctx.claude.client_id, client_secret: ctx.claude.client_secret, resource: MCP_URL });
    const tok = await json(res);
    expect(res.status === 200, `HTTP ${res.status} ${JSON.stringify(tok)}`);
    const again = await tokenRequest({ grant_type: "refresh_token", refresh_token: ctx.refresh, client_id: ctx.claude.client_id, client_secret: ctx.claude.client_secret });
    expect(again.status === 400, `reused refresh token → HTTP ${again.status}`);
    ctx.token = tok.access_token;
  });

  // ── 4. the MCP session ──────────────────────────────────────────────
  await step("POST /mcp initialize (2025-11-25, MCP Apps capability) → 200 + Mcp-Session-Id", async () => {
    const res = await mcp(ctx.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: UI_CAPS, clientInfo: { name: "claude-ai", version: "0.1.0" } },
    });
    expect(res.status === 200, `HTTP ${res.status} ${await res.clone().text().then((t) => t.slice(0, 200))}`);
    ctx.session = res.headers.get("mcp-session-id");
    const body = await rpcBody(res);
    expect(body.result?.serverInfo?.name === "openkt", "no serverInfo");
    ctx.protocol = body.result.protocolVersion;
    expect(ctx.session, "no Mcp-Session-Id header");
    return `protocol ${ctx.protocol}, session ${ctx.session.slice(0, 8)}…`;
  });

  const sessionHeaders = () => ({ "mcp-session-id": ctx.session, "mcp-protocol-version": ctx.protocol });

  await step("notifications/initialized → 202", async () => {
    const res = await mcp(ctx.token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders());
    expect(res.status === 202, `HTTP ${res.status}`);
  });

  await step("tools/list → the kt_ tools, and the cards for an MCP Apps client", async () => {
    const res = await mcp(ctx.token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionHeaders());
    expect(res.status === 200, `HTTP ${res.status}`);
    const names = (await rpcBody(res)).result.tools.map((t) => t.name);
    for (const n of ["kt_session_start", "kt_recall", "kt_save_memory", "kt_session_end", "kt_save_card"]) expect(names.includes(n), `missing ${n}`);
    return `${names.length} tools`;
  });

  await step("tools/call kt_list_projects (with the ChatGPT client's token)", async () => {
    const res = await mcp(ctx.chatgptToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kt_list_projects", arguments: {} } }, sessionHeaders());
    const body = await rpcBody(res);
    expect(res.status === 200 && !body.error && !body.result?.isError, `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  });

  await step("GET /mcp (SSE stream) → 200 text/event-stream or 405", async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(MCP_URL, { headers: { authorization: `Bearer ${ctx.token}`, accept: "text/event-stream", ...sessionHeaders() }, signal: ac.signal });
      const ok = res.status === 405 || (res.status === 200 && (res.headers.get("content-type") || "").includes("text/event-stream"));
      expect(ok, `HTTP ${res.status} ${res.headers.get("content-type")}`);
      return `HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  });

  await step("DELETE /mcp (end session) → 200/204/405", async () => {
    const res = await fetch(MCP_URL, { method: "DELETE", headers: { authorization: `Bearer ${ctx.token}`, ...sessionHeaders() } });
    expect([200, 202, 204, 405].includes(res.status), `HTTP ${res.status}`);
    return `HTTP ${res.status}`;
  });

  await step("an expired / unknown token → 401 with WWW-Authenticate (clients re-run sign-in)", async () => {
    const res = await mcp("okt_pat_" + "0".repeat(64), { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    expect(res.status === 401 && (res.headers.get("www-authenticate") || "").startsWith("Bearer"), `HTTP ${res.status} ${res.headers.get("www-authenticate")}`);
  });

  await step("legacy /v1/mcp still answers (older configs)", async () => {
    const res = await fetch(`${BASE}/v1/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.token}`, accept: ACCEPT, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status === 200, `HTTP ${res.status}`);
  });

  // ── 5. CORS for browser-based clients ───────────────────────────────
  for (const origin of ["https://claude.ai", "https://chatgpt.com"]) {
    await step(`CORS preflight OPTIONS /mcp from ${origin}`, async () => {
      const res = await fetch(MCP_URL, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
        },
      });
      expect(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      const acao = res.headers.get("access-control-allow-origin");
      expect(acao === origin || acao === "*", `Access-Control-Allow-Origin: ${acao}`);
      const allowed = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
      for (const h of ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id"]) expect(allowed.includes(h), `allow-headers lacks ${h}: "${allowed}"`);
    });
  }

  await step("CORS: a 401 from /mcp exposes WWW-Authenticate; initialize exposes Mcp-Session-Id", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { origin: "https://claude.ai", accept: ACCEPT, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const acao = res.headers.get("access-control-allow-origin");
    const expose = (res.headers.get("access-control-expose-headers") || "").toLowerCase();
    expect(acao === "https://claude.ai" || acao === "*", `Access-Control-Allow-Origin: ${acao}`);
    expect(expose.includes("www-authenticate") && expose.includes("mcp-session-id"), `expose-headers: "${expose}"`);
  });

  for (const [method, path] of [["GET", "/.well-known/oauth-protected-resource"], ["GET", "/.well-known/oauth-authorization-server"], ["POST", "/oauth/register"], ["POST", "/oauth/token"]]) {
    await step(`CORS preflight ${method} ${path} from https://claude.ai`, async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": method, "access-control-request-headers": "content-type" },
      });
      const acao = res.headers.get("access-control-allow-origin");
      expect(res.status < 300 && (acao === "https://claude.ai" || acao === "*"), `HTTP ${res.status}, Access-Control-Allow-Origin: ${acao}`);
    });
  }

  // ── 6. the agent-readable setup text ────────────────────────────────
  for (const path of ["/connect", "/llms.txt"]) {
    await step(`GET ${path} → text/markdown an agent can follow`, async () => {
      const res = await fetch(`${BASE}${path}`);
      const text = await res.text();
      expect(res.status === 200 && (res.headers.get("content-type") || "").startsWith("text/markdown"), `HTTP ${res.status} ${res.headers.get("content-type")}`);
      expect(text.includes("Add this MCP server: https://mcp.openkt.ai/mcp"), "does not open with the one-line setup");
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — failed: ${failed.map((f) => f.name).join(" | ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
