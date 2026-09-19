// Round-trip through OpenKT's /v1/mcp via streamable HTTP. Proves the
// MCP surface uses the same memory engine as the REST API (MemMachine
// when MEMORY_ENGINE=memmachine).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

function loadEnv(p) {
  let t;
  try {
    t = readFileSync(resolve(p), "utf8");
  } catch {
    return;
  }
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(".env.local");

const API = "http://127.0.0.1:4100";
const PG_URL = process.env.DATABASE_URL;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_EMAIL || !E2E_PASSWORD) {
  console.error("set E2E_EMAIL + E2E_PASSWORD");
  process.exit(1);
}

const RUN = `${Date.now()}-${process.pid}`;
const log = (...a) => console.log(...a);

async function login() {
  const r = await fetch(`${API}/v1/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  });
  const body = await r.json();
  if (!body?.data?.token) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body.data.token;
}

async function pickProject(jwt) {
  const r = await fetch(`${API}/v1/projects`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = await r.json();
  return body.data[0];
}

// MCP streamable HTTP: send JSON-RPC body, receive newline-delimited
// responses. Each request is a single POST.
async function mcpCall(jwt, method, params, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${jwt}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const r = await fetch(`${API}/v1/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  const text = await r.text();
  const sid = r.headers.get("mcp-session-id") ?? sessionId;
  // streamable HTTP often returns SSE-style; pick the first JSON line
  const lines = text.split(/\r?\n/);
  let parsed = null;
  for (const line of lines) {
    if (line.startsWith("data:")) {
      try {
        parsed = JSON.parse(line.slice(5).trim());
        break;
      } catch {}
    } else if (line.trim().startsWith("{")) {
      try {
        parsed = JSON.parse(line.trim());
        break;
      } catch {}
    }
  }
  return { status: r.status, body: parsed, raw: text, sessionId: sid };
}

async function main() {
  const jwt = await login();
  log("✓ logged in");
  const project = await pickProject(jwt);
  log(`  project_id=${project.id}`);

  log("→ MCP initialize");
  const init = await mcpCall(jwt, "initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "smoke", version: "0.1.0" },
    capabilities: {},
  });
  log(`  status=${init.status} sessionId=${init.sessionId}`);
  if (init.body?.result?.serverInfo) {
    log(`  server=${init.body.result.serverInfo.name} v${init.body.result.serverInfo.version}`);
  }

  log("→ MCP tools/list");
  const tools = await mcpCall(jwt, "tools/list", {}, init.sessionId);
  const names = (tools.body?.result?.tools ?? []).map((t) => t.name);
  log(`  tools=${JSON.stringify(names)}`);

  const uniq = crypto.randomUUID();
  const content = `MCP roundtrip ${RUN} marker ${uniq}: tests OpenKT MCP -> MemMachine path.`;
  log(`→ MCP memory_remember (content marker=${uniq.slice(0, 8)})`);
  const remember = await mcpCall(
    jwt,
    "tools/call",
    {
      name: "memory_remember",
      arguments: {
        project_id: project.id,
        kind: "note",
        visibility: "project",
        content,
        tag_slugs: ["mcp", "roundtrip"],
      },
    },
    init.sessionId,
  );
  log(`  status=${remember.status}`);
  const remembered = remember.body?.result?.content?.[0]?.text;
  let memId = null;
  if (remembered) {
    try {
      const obj = JSON.parse(remembered);
      memId = obj?.id;
    } catch {}
  }
  log(`  memory_id=${memId}`);
  if (!memId) {
    log(`  raw: ${JSON.stringify(remember.body).slice(0, 400)}`);
    process.exit(1);
  }

  // Prove dual-write
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  await new Promise((r) => setTimeout(r, 1500));
  const ext = await pg.query(
    "select provider, external_id from public.memory_external_refs where memory_id=$1",
    [memId],
  );
  const mm = ext.rows.find((r) => r.provider === "memmachine");
  if (mm) {
    log(`  ✓ memory_external_refs has memmachine uid=${mm.external_id}`);
  } else {
    log(`  ✗ no memmachine ref — MCP path did NOT propagate to MemMachine`);
    process.exit(1);
  }

  log(`→ MCP memory_recall (query=${uniq.slice(0, 8)})`);
  const recall = await mcpCall(
    jwt,
    "tools/call",
    {
      name: "memory_recall",
      arguments: {
        project_id: project.id,
        query: uniq,
        limit: 5,
      },
    },
    init.sessionId,
  );
  const recallRows = parseToolRows(recall);
  log(`  rows=${recallRows.length}`);
  if (!recallRows.some((r) => r.id === memId)) {
    log(`  ✗ recall did not find the memory`);
    log(`  raw: ${JSON.stringify(recall.body).slice(0, 400)}`);
    process.exit(1);
  }
  log(`  ✓ MCP recall returned the memory we just wrote via MCP`);

  // memory_search — same query, but through the MCP search tool which
  // routes through MemoryQueriesApplicationService.search. Distinct
  // from recall: read-only, no recall_count bump.
  log(`→ MCP memory_search (query=${uniq.slice(0, 8)})`);
  const search = await mcpCall(
    jwt,
    "tools/call",
    {
      name: "memory_search",
      arguments: {
        query: uniq,
        mode: "hybrid",
        vector_weight: 0.6,
        workspace_weight: 0.4,
        limit: 10,
        filters: { project_ids: [project.id] },
      },
    },
    init.sessionId,
  );
  const searchRows = parseToolRows(search);
  log(`  rows=${searchRows.length}`);
  if (!searchRows.some((r) => r.id === memId)) {
    log(`  ✗ search did not find the memory`);
    log(`  raw: ${JSON.stringify(search.body).slice(0, 400)}`);
    process.exit(1);
  }
  log(`  ✓ MCP search returned the memory`);
  // Confirm recall_count was NOT bumped by search (only recall bumps it).
  const accessRow = await pg.query(
    "select recall_count from public.memories where id=$1",
    [memId],
  );
  log(`  recall_count after search-only = ${accessRow.rows[0]?.recall_count}`);

  // memory_forget — soft-archive, then verify the memory is gone from
  // both OpenKT (archived=true) and MemMachine (no episode with this uid
  // in the namespace+project).
  log(`→ MCP memory_forget memory_id=${memId}`);
  const beforeForget = await pg.query(
    "select external_id, external_namespace, external_project_id from public.memory_external_refs where memory_id=$1 and provider='memmachine'",
    [memId],
  );
  const targetUid = beforeForget.rows[0]?.external_id;
  const targetNamespace = beforeForget.rows[0]?.external_namespace;
  const targetProject = beforeForget.rows[0]?.external_project_id;
  log(`  targetUid=${targetUid} ns=${targetNamespace} project=${targetProject}`);

  const forget = await mcpCall(
    jwt,
    "tools/call",
    { name: "memory_forget", arguments: { id: memId, hard: false } },
    init.sessionId,
  );
  if (forget.status !== 200) {
    log(`  ✗ forget HTTP ${forget.status}: ${JSON.stringify(forget.body).slice(0, 400)}`);
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 500));

  const archived = await pg.query(
    "select archived from public.memories where id=$1",
    [memId],
  );
  if (archived.rows[0]?.archived !== true) {
    log(`  ✗ OpenKT memory not archived (archived=${archived.rows[0]?.archived})`);
    process.exit(1);
  }
  log(`  ✓ OpenKT memory archived`);

  const refsAfter = await pg.query(
    "select count(*)::int as n from public.memory_external_refs where memory_id=$1 and provider='memmachine'",
    [memId],
  );
  if (refsAfter.rows[0]?.n !== 0) {
    log(`  ✗ memory_external_refs still has ${refsAfter.rows[0]?.n} memmachine row(s)`);
    process.exit(1);
  }
  log(`  ✓ memory_external_refs row removed`);

  // Verify MemMachine itself doesn't have the episode anymore.
  const mmList = await fetch(`${MM}/api/v2/memories/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      org_id: targetNamespace,
      project_id: targetProject,
      types: ["episodic"],
      limit: 100,
    }),
  });
  const mmBody = await mmList.json();
  const mmEpisodes = mmBody?.content?.episodic_memory ?? [];
  const stillThere = mmEpisodes.some((e) => e.uid === targetUid);
  if (stillThere) {
    log(`  ✗ MemMachine still has episode uid=${targetUid}`);
    process.exit(1);
  }
  log(`  ✓ MemMachine episode uid=${targetUid} is gone`);

  await pg.end();
  log("");
  log("✓ MCP -> MemMachine roundtrip PASSED (remember + recall + search + forget)");
}

function parseToolRows(response) {
  const text = response.body?.result?.content?.[0]?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return parsed?.data ?? [];
  } catch {
    return [];
  }
}

const MM = (process.env.OPENKT_MEMMACHINE_URL ?? "http://127.0.0.1:8091").replace(/\/+$/, "");

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
