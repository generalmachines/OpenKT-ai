#!/usr/bin/env node
// e2e shakeout — exercises the full memory ingest -> embed -> triage ->
// episode -> recall pipeline against the local stack. Uses the Supabase
// admin key to create a throwaway test user and mint a JWT, then drives
// the API over HTTP exactly like a real client would.
//
// Run from api/ with .env.local in place:
//   node scripts/smoke-e2e-shakeout.mjs
//
// Knobs (via env):
//   API_BASE_URL     default http://127.0.0.1:4100
//   E2E_TIMEOUT_S    default 120
//   PG_URL           default $DATABASE_URL (used for pipeline assertions)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(resolve(path), "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(".env.local");
loadEnvFile(".env");

const API_BASE_URL = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";
const TIMEOUT_S = Number(process.env.E2E_TIMEOUT_S ?? "180");
const PG_URL =
  process.env.DATABASE_URL ??
  process.env.DATA_POSTGRES_URL ??
  process.env.POSTGRES_URL;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;

function fail(msg) {
  console.error("✗", msg);
  process.exit(1);
}

if (!PG_URL) fail("missing DATABASE_URL");
if (!E2E_EMAIL || !E2E_PASSWORD)
  fail("set E2E_EMAIL and E2E_PASSWORD to a real Supabase user with a project");

const RUN_TAG = `${Date.now()}-${process.pid}`;

const log = (...a) => console.log(...a);

async function mintJwt() {
  log(`→ logging in ${E2E_EMAIL} via /v1/auth/password`);
  const r = await fetch(`${API_BASE_URL}/v1/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 200 && r.status !== 201)
    fail(`/v1/auth/password ${r.status}: ${JSON.stringify(body)}`);
  const jwt = body?.data?.token;
  const userId = body?.data?.user?.id;
  if (!jwt) fail(`/v1/auth/password returned no token: ${JSON.stringify(body)}`);
  log(`  user_id=${userId}`);
  return { userId, jwt };
}

async function api(method, path, jwt, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "x-openkt-surface": "smoke",
      "x-request-id": `e2e-shakeout-${RUN_TAG}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave raw */
  }
  return { status: res.status, body: json ?? text };
}

async function pickProject(jwt) {
  const r = await api("GET", "/v1/projects", jwt);
  if (r.status !== 200)
    fail(`GET /v1/projects ${r.status}: ${JSON.stringify(r.body)}`);
  const projects = r.body?.data ?? [];
  if (projects.length === 0)
    fail("no projects available — auto-bootstrap may have failed");
  log(`  project_id=${projects[0].id} (${projects[0].slug})`);
  return projects[0];
}

async function postMemory(jwt, projectId) {
  // Make the content lexically distinctive so the triage stage's
  // duplicate detector (cosine + LLM) doesn't archive it as a dupe of
  // an earlier shakeout run. The UUID-only payload has no semantic
  // overlap with prior smoke memories. We also use the marker as the
  // recall query later, so it's the most specific signal to MemMachine.
  const uniqueId = crypto.randomUUID();
  const content = `Shakeout marker ${uniqueId}: this memory is unique to run ${RUN_TAG} and should round-trip through MemMachine + recall.`;
  const r = await api("POST", "/v1/memories", jwt, {
    project_id: projectId,
    kind: "note",
    visibility: "project",
    content,
    tag_slugs: ["e2e", "shakeout"],
  });
  if (r.status !== 200 && r.status !== 201)
    fail(`POST /v1/memories ${r.status}: ${JSON.stringify(r.body)}`);
  const memId = r.body?.data?.id;
  if (!memId) fail(`memory create missing id: ${JSON.stringify(r.body)}`);
  log(`  memory_id=${memId}`);
  return { memoryId: memId, content, uniqueId };
}

async function pgClient() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  return c;
}

async function waitUntil(label, fn) {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) {
        log(`  ✓ ${label}`);
        return v;
      }
      last = v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  fail(`${label} timed out after ${TIMEOUT_S}s; last=${JSON.stringify(last)}`);
}

async function main() {
  log("=== e2e shakeout ===");
  log(`API:    ${API_BASE_URL}`);
  log(`PG:     ${PG_URL?.replace(/:[^:@]*@/, ":****@")}`);
  log(`Run:    ${RUN_TAG}`);
  log("");

  const { userId, jwt } = await mintJwt();
  const project = await pickProject(jwt);
  const { memoryId, uniqueId } = await postMemory(jwt, project.id);
  log("");

  const pg = await pgClient();
  try {
    await waitUntil(
      "outbox_events.published_at set",
      async () => {
        const r = await pg.query(
          "select published_at, attempts, last_error from public.outbox_events where aggregate_id = $1",
          [memoryId],
        );
        return r.rows.length > 0 && r.rows.some((row) => row.published_at !== null)
          ? r.rows
          : null;
      },
    );

    // Prove the OpenKT -> MemMachine dual-write landed. If
    // MEMORY_ENGINE=memmachine, every memory create should record an
    // external_ref pointing at MemMachine's uid.
    const extRefs = await pg.query(
      "select provider, external_id from public.memory_external_refs where memory_id=$1",
      [memoryId],
    );
    const memMachineRef = extRefs.rows.find((r) => r.provider === "memmachine");
    if (memMachineRef) {
      log(`  ✓ memory_external_refs has memmachine uid=${memMachineRef.external_id}`);
    } else {
      log(`  ⓘ no memmachine external_ref (MEMORY_ENGINE=local or write fail)`);
    }

    await waitUntil(
      "agentic_jobs[stage=preprocess].status=done",
      async () => {
        const r = await pg.query(
          "select status, error from public.agentic_jobs where memory_id=$1 and stage='preprocess'",
          [memoryId],
        );
        return r.rows.some((x) => x.status === "done") ? r.rows : null;
      },
    );

    await waitUntil("agentic_jobs[stage=embed].status=done", async () => {
      const r = await pg.query(
        "select status, result, error from public.agentic_jobs where memory_id=$1 and stage='embed'",
        [memoryId],
      );
      return r.rows.some((x) => x.status === "done") ? r.rows : null;
    });

    // The local pgvector embedding is only written by the worker when
    // MEMORY_ENGINE=local. With MemMachine as the engine, embedding
    // is owned by MemMachine and the OpenKT column stays null on
    // purpose — the recall assertion below proves the memory is
    // findable regardless. Just report which path we're on.
    const { rows: embedJobRows } = await pg.query(
      "select result from public.agentic_jobs where memory_id=$1 and stage='embed' order by created_at desc limit 1",
      [memoryId],
    );
    const embedReason = embedJobRows[0]?.result?.reason ?? null;
    const { rows: embRows } = await pg.query(
      "select id, embedding is not null as has_embedding from public.memories where id = $1",
      [memoryId],
    );
    if (embRows[0]?.has_embedding) {
      log("  ✓ memories.embedding is populated (local pgvector path)");
    } else if (embedReason === "embedding owned by memmachine") {
      log("  ⓘ memories.embedding is null — owned by MemMachine (no double TEI call)");
    } else {
      fail(`memory.embedding is null AND embed stage didn't say MemMachine owns it (reason=${embedReason})`);
    }

    const triageRows = await waitUntil(
      "agentic_jobs[stage=triage].status=done",
      async () => {
        const r = await pg.query(
          "select status, result, error from public.agentic_jobs where memory_id=$1 and stage='triage'",
          [memoryId],
        );
        return r.rows.some((x) => x.status === "done") ? r.rows : null;
      },
    );
    const archivedAsDuplicate = triageRows.some(
      (r) => r.result?.archived_as_duplicate === true,
    );
    if (archivedAsDuplicate) {
      log("  ⓘ triage archived this memory as a duplicate — episode is intentionally skipped");
    } else {
      await waitUntil("agentic_jobs[stage=episode].status=done", async () => {
        const r = await pg.query(
          "select status, error from public.agentic_jobs where memory_id=$1 and stage='episode'",
          [memoryId],
        );
        return r.rows.some((x) => x.status === "done") ? r.rows : null;
      });
    }

    await waitUntil("agentic_jobs[stage=briefing].status=done", async () => {
      const r = await pg.query(
        "select status, error from public.agentic_jobs where project_id=$1 and stage='briefing' and created_at > now() - interval '5 minutes'",
        [project.id],
      );
      return r.rows.some((x) => x.status === "done") ? r.rows : null;
    });

    log("");
    log("→ recall against /v1/memories/recall (query=unique marker)");
    const recall = await api("POST", "/v1/memories/recall", jwt, {
      project_id: project.id,
      query: uniqueId,
      limit: 10,
      vector_weight: 0.6,
    });
    if (recall.status !== 200)
      fail(`POST /v1/memories/recall ${recall.status}: ${JSON.stringify(recall.body)}`);
    const recallRows = recall.body?.data ?? [];
    log(`  recall returned ${recallRows.length} row(s)`);
    const found = recallRows.some((r) => r.id === memoryId);
    if (!found)
      fail(
        `recall did not return our memory ${memoryId}; got ${JSON.stringify(
          recallRows.map((r) => r.id),
        )}`,
      );
    log(`  ✓ recall returned memory_id=${memoryId}`);

    log("");
    log("→ stage roll-up");
    const rollup = await pg.query(
      `select stage, status, attempts, error,
              (result->>'reason')          as reason,
              (result->>'embedded')::text  as embedded,
              (result->>'skipped')::text   as skipped
         from public.agentic_jobs
        where memory_id=$1 or (project_id=$2 and stage='briefing' and created_at > now() - interval '5 minutes')
        order by created_at`,
      [memoryId, project.id],
    );
    for (const r of rollup.rows) {
      const detail = [
        r.error ? `err=${r.error}` : null,
        r.reason ? `reason=${r.reason}` : null,
        r.embedded === "true" ? "embedded=true" : null,
        r.skipped === "true" ? "skipped=true" : null,
      ]
        .filter(Boolean)
        .join("  ");
      console.log(
        `  ${(r.stage ?? "?").padEnd(10)} ${r.status.padEnd(6)} attempts=${r.attempts}  ${detail}`,
      );
    }

    log("");
    log("✓ e2e shakeout PASSED");
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error("✗ shakeout crashed:", e?.stack ?? e);
  process.exit(1);
});
