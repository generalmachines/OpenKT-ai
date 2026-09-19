#!/usr/bin/env node
// Connects to OpenKT the way SDK-based MCP clients do (Claude Code, Cursor, the MCP Inspector, many browser
// agents): the official @modelcontextprotocol/sdk client with its OAuth implementation — discovery from the
// 401, Dynamic Client Registration, PKCE — then initialize + tools/list. The one browser step (the sign-in page)
// is completed the way a person would: open the URL the SDK asks to open, sign in, follow the redirect.
//
//   OPENKT_REPLAY_EMAIL=… OPENKT_REPLAY_PASSWORD=… node server/scripts/sdk-oauth-check.mjs [https://mcp.openkt.ai/mcp]
const serverUrl = new URL(process.argv[2] || "https://mcp.openkt.ai/mcp");
const email = process.env.OPENKT_REPLAY_EMAIL;
const password = process.env.OPENKT_REPLAY_PASSWORD;
if (!email || !password) throw new Error("set OPENKT_REPLAY_EMAIL and OPENKT_REPLAY_PASSWORD");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");

const REDIRECT = "http://127.0.0.1:33418/callback";
const store = {};
let authorizationUrl = null;
const provider = {
  get redirectUrl() { return REDIRECT; },
  get clientMetadata() {
    return { client_name: "SDK check", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  },
  state: () => `st-${Date.now()}`,
  clientInformation: () => store.client,
  saveClientInformation: (c) => { store.client = c; },
  tokens: () => store.tokens,
  saveTokens: (t) => { store.tokens = t; },
  redirectToAuthorization: (url) => { authorizationUrl = url; },
  saveCodeVerifier: (v) => { store.verifier = v; },
  codeVerifier: () => store.verifier,
};

// The person in the browser: open the page, sign in, Allow → the redirect carries the code.
async function browser(url) {
  const page = await fetch(url, { redirect: "manual" });
  const html = await page.text();
  const fields = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const post = await fetch(new URL("/oauth/authorize", url), {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ ...fields, mode: "signin", action: "allow", email, password }),
  });
  if (post.status !== 302) throw new Error(`sign-in page answered ${post.status}`);
  return new URL(post.headers.get("location")).searchParams.get("code");
}

const log = (...a) => console.log(...a);
let transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
let client = new Client({ name: "sdk-oauth-check", version: "0.0.1" });
try {
  await client.connect(transport);
  throw new Error("connected without signing in?");
} catch (err) {
  if (!(err instanceof UnauthorizedError)) throw err;
  log(`1. 401 → SDK discovered the server, registered client ${store.client?.client_id?.slice(0, 18)}…, and asks to open:`);
  log(`   ${authorizationUrl.origin}${authorizationUrl.pathname}?client_id=…&resource=${authorizationUrl.searchParams.get("resource")}&scope=${authorizationUrl.searchParams.get("scope")}`);
}
const code = await browser(authorizationUrl);
log("2. signed in on the page → redirect with a code");
await transport.finishAuth(code);
log(`3. SDK exchanged the code (PKCE) → access token ${store.tokens.access_token.slice(0, 12)}…, refresh token ${store.tokens.refresh_token ? "yes" : "no"}`);
transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
client = new Client({ name: "sdk-oauth-check", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
log(`4. initialize + tools/list: ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}, ${tools.tools.length} tools (${tools.tools.slice(0, 4).map((t) => t.name).join(", ")}, …)`);
const projects = await client.callTool({ name: "kt_list_projects", arguments: {} });
log(`5. kt_list_projects → ${JSON.parse(projects.content[0].text).count} spaces`);
await client.close();
log("OK");
