#!/usr/bin/env node
import crypto from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: [".env.local", ".env"] });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = `shakeout-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const bgeUrl = (process.env.OPENKT_BGE_URL ?? "http://127.0.0.1:8090/embed")
  .replace(/\/embed$/, "/v1/embeddings");
const bgeModel = process.env.OPENKT_BGE_MODEL ?? "BAAI/bge-m3";
const memMachineUrl = (process.env.OPENKT_MEMMACHINE_URL ?? "http://127.0.0.1:8091").replace(/\/+$/, "");

async function main() {
  await db.connect();

  const fixture = await createFixture();
  for (const memory of fixture.memories) {
    await insertMemoryAndOutbox(memory);
  }

  const pipeline = await waitForPipeline(fixture.memories.map((memory) => memory.id));
  const briefings = await fetchBriefings(fixture.projects.map((project) => project.id));
  const vectorRecall = await directVectorRecall(fixture.projects[1].id, "memory engine adapter MemMachine recall");
  const memMachineProbe = await probeMemMachineForOpenKtMemory(fixture.memories[0]);

  const report = {
    run_id: runId,
    fixture: {
      users: fixture.users,
      org: fixture.org,
      projects: fixture.projects,
      memories: fixture.memories.map(({ id, project_id, owner_user_id, content }) => ({
        id,
        project_id,
        owner_user_id,
        content,
      })),
    },
    implemented_today: {
      memmachine_adapter_in_openkt: false,
      openkt_memory_external_refs_table: await tableExists("memory_external_refs"),
      api_recall_native_drizzle: false,
      rabbitmq_outbox_pipeline: true,
      bge_pgvector_embedding: true,
      minimax_briefing_synthesis: briefings.some((row) => row.model?.includes("MiniMax")),
      triage_stage: pipeline.jobs.some((job) => job.stage === "triage"),
      episode_stage: pipeline.jobs.some((job) => job.stage === "episode"),
      automatic_pulse_from_memory: false,
    },
    pipeline,
    briefings,
    direct_pgvector_recall: vectorRecall,
    memmachine_probe: memMachineProbe,
  };

  console.log(JSON.stringify(report, null, 2));
}

async function createFixture() {
  const alice = {
    id: crypto.randomUUID(),
    email: `${runId}-alice@example.com`,
    display_name: "Shakeout Alice",
  };
  const bob = {
    id: crypto.randomUUID(),
    email: `${runId}-bob@example.com`,
    display_name: "Shakeout Bob",
  };
  const org = {
    id: crypto.randomUUID(),
    slug: runId,
    name: `Shakeout ${runId}`,
  };
  const projects = [
    {
      id: crypto.randomUUID(),
      org_id: null,
      slug: `${runId}-alice`,
      name: "Alice Personal Shakeout",
      visibility: "personal",
      owner_user_id: alice.id,
    },
    {
      id: crypto.randomUUID(),
      org_id: org.id,
      slug: `${runId}-platform`,
      name: "Org Platform Shakeout",
      visibility: "org",
      owner_user_id: alice.id,
    },
    {
      id: crypto.randomUUID(),
      org_id: null,
      slug: `${runId}-bob`,
      name: "Bob Personal Shakeout",
      visibility: "personal",
      owner_user_id: bob.id,
    },
  ];

  await db.query(
    `insert into users(id, email, email_verified, display_name, created_at, updated_at)
     values ($1, $2, true, $3, now(), now()), ($4, $5, true, $6, now(), now())`,
    [alice.id, alice.email, alice.display_name, bob.id, bob.email, bob.display_name],
  );
  await db.query(
    `insert into profiles(user_id, email, display_name, created_at)
     values ($1, $2, $3, now()), ($4, $5, $6, now())`,
    [alice.id, alice.email, alice.display_name, bob.id, bob.email, bob.display_name],
  );
  await db.query(
    `insert into orgs(id, slug, name, created_by, created_at)
     values ($1, $2, $3, $4, now())`,
    [org.id, org.slug, org.name, alice.id],
  );
  await db.query(
    `insert into org_members(org_id, user_id, role, invited_by, joined_at)
     values ($1, $2, 'owner', null, now()), ($1, $3, 'member', $2, now())`,
    [org.id, alice.id, bob.id],
  );
  for (const project of projects) {
    await db.query(
      `insert into projects(id, slug, name, visibility, org_id, owner_user_id, created_at, updated_at)
       values($1, $2, $3, $4, $5, $6, now(), now())`,
      [project.id, project.slug, project.name, project.visibility, project.org_id, project.owner_user_id],
    );
  }

  const memories = [
    memory(projects[0], alice, "decision", `Alice personal note ${runId}: OpenKT CLI init should register the repository project and show it in the dashboard.`),
    memory(projects[1], alice, "decision", `Org platform note ${runId}: OpenKT should use a MemoryEngine adapter so MemMachine can store and retrieve memories internally.`),
    memory(projects[1], bob, "context", `Org platform context ${runId}: RabbitMQ remains the OpenKT synthesis layer for briefings, pulse, and agent context packs.`),
    memory(projects[1], alice, "pattern", `Org platform pattern ${runId}: retrieved memories must be synthesized before sending context to Claude Code, Cursor, or Codex.`),
    memory(projects[2], bob, "decision", `Bob personal note ${runId}: BGE-M3 embeddings are stored in Postgres pgvector for native fallback recall.`),
    memory(projects[2], bob, "context", `Bob personal context ${runId}: MiniMax-M2.5 is the currently working LLM model for local synthesis tests.`),
  ];

  return { users: [alice, bob], org, projects, memories };
}

function memory(project, user, kind, content) {
  return {
    id: crypto.randomUUID(),
    org_id: project.org_id,
    project_id: project.id,
    owner_user_id: user.id,
    kind,
    content,
  };
}

async function insertMemoryAndOutbox(memory) {
  const inserted = await db.query(
    `insert into memories(
       id, org_id, project_id, owner_user_id, content, kind, visibility,
       confidence, importance, source_refs, created_at, updated_at
     ) values($1, $2, $3, $4, $5, $6, 'project', 1, 0.75, $7::jsonb, now(), now())
     returning created_at::text as created_at, updated_at::text as updated_at`,
    [
      memory.id,
      memory.org_id,
      memory.project_id,
      memory.owner_user_id,
      memory.content,
      memory.kind,
      JSON.stringify([{ kind: "decision", ref: runId }]),
    ],
  );
  const row = inserted.rows[0];
  await db.query(
    `insert into outbox_events(aggregate_type, aggregate_id, event_type, payload, created_at, next_attempt_at)
     values('memory', $1, 'memory.created', $2::jsonb, now(), now())`,
    [
      memory.id,
      JSON.stringify({
        memory_id: memory.id,
        project_id: memory.project_id,
        org_id: memory.org_id,
        owner_user_id: memory.owner_user_id,
        kind: memory.kind,
        visibility: "project",
        content_length: memory.content.length,
        source_refs: [{ kind: "decision", ref: runId }],
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
    ],
  );
}

async function waitForPipeline(memoryIds) {
  for (let i = 0; i < 120; i += 1) {
    const summary = await pipelineSummary(memoryIds);
    const allEmbedded = summary.memories.every((row) => row.embedded || row.archived || row.superseded_by);
    const allOutboxPublished = summary.outbox.every((row) => row.published_at);
    const memoryStagesDone = summary.memories.every((memory) =>
      ["preprocess", "embed", "triage", "episode"].every((stage) =>
        summary.jobs.some((job) => (
          job.memory_id === memory.id &&
          job.stage === stage &&
          isTerminal(job.status)
        )),
      ),
    );
    const projectBriefingsDone = summary.jobs
      .filter((job) => job.stage === "briefing")
      .every((job) => isTerminal(job.status));
    if (allEmbedded && allOutboxPublished && memoryStagesDone && projectBriefingsDone) return summary;
    await sleep(1000);
  }
  return pipelineSummary(memoryIds);
}

function isTerminal(status) {
  return status === "done" || status === "skipped" || status === "failed";
}

async function pipelineSummary(memoryIds) {
  const outbox = await db.query(
    `select aggregate_id, published_at::text, attempts, last_error
       from outbox_events
      where aggregate_id = any($1::uuid[])
      order by created_at`,
    [memoryIds],
  );
  const memories = await db.query(
    `select id, project_id, embedding is not null as embedded, archived, superseded_by
       from memories
      where id = any($1::uuid[])
      order by created_at`,
    [memoryIds],
  );
  const jobs = await db.query(
    `select memory_id, project_id, stage, status, attempts, error, result
       from agentic_jobs
      where memory_id = any($1::uuid[])
         or project_id in (select distinct project_id from memories where id = any($1::uuid[]))
      order by created_at`,
    [memoryIds],
  );
  const episodes = await db.query(
    `select e.id, e.project_id, e.name, e.summary, e.member_count
       from episodes e
      where e.project_id in (select distinct project_id from memories where id = any($1::uuid[]))
      order by e.created_at`,
    [memoryIds],
  );
  return {
    outbox: outbox.rows,
    memories: memories.rows,
    jobs: jobs.rows,
    episodes: episodes.rows,
  };
}

async function fetchBriefings(projectIds) {
  const briefings = await db.query(
    `select project_id, generated_at::text, model, source_memory_count_at_generation,
            source_memory_ids, left(briefing_md, 500) as briefing_preview
       from team_briefings
      where project_id = any($1::uuid[])
      order by project_id, generated_at desc`,
    [projectIds],
  );
  return briefings.rows;
}

async function directVectorRecall(projectId, query) {
  const vector = await embed(query);
  if (!vector) return { available: false, reason: "embedding service unavailable" };
  const rows = await db.query(
    `select id, content, kind, (1 - (embedding <=> $2::vector))::real as similarity
       from memories
      where project_id = $1
        and archived = false
        and embedding is not null
      order by embedding <=> $2::vector
      limit 5`,
    [projectId, toPgVector(vector)],
  );
  return { available: true, query, rows: rows.rows };
}

async function embed(input) {
  const response = await fetch(bgeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: bgeModel, input }),
  }).catch(() => null);
  if (!response?.ok) return null;
  const json = await response.json();
  return json?.data?.[0]?.embedding ?? json?.embeddings?.[0] ?? null;
}

function toPgVector(vector) {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(",")}]`;
}

async function probeMemMachineForOpenKtMemory(memory) {
  const payload = {
    org_id: memory.org_id ?? `personal:${memory.owner_user_id}`,
    project_id: memory.project_id,
    query: memory.content,
    top_k: 5,
    types: ["episodic", "semantic"],
  };
  const response = await fetch(`${memMachineUrl}/api/v2/memories/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return {
    checked: true,
    expectation: "should be empty/not found until OpenKT has a real MemMachine adapter",
    status: response.status,
    response: parsed,
  };
}

async function tableExists(table) {
  const result = await db.query(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = $1
     ) as exists`,
    [table],
  );
  return Boolean(result.rows[0]?.exists);
}

try {
  await main();
} finally {
  await db.end().catch(() => undefined);
}
