#!/usr/bin/env node
import crypto from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: [".env.local", ".env"] });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const memories = [
  {
    label: "base",
    content:
      "Decision: OpenKT server memory ingestion uses a transactional outbox, RabbitMQ commands, BGE-M3 embeddings, and Postgres pgvector storage.",
  },
  {
    label: "near-duplicate",
    content:
      "Decision: OpenKT backend memory ingestion uses the outbox plus RabbitMQ pipeline; the worker writes BGE-M3 pgvector embeddings into Postgres.",
  },
  {
    label: "update",
    content:
      "Update: OpenKT memory ingestion still uses the RabbitMQ outbox pipeline, but BGE-M3 embeddings should be served by a private AWS-hosted TEI service instead of a local Python process.",
  },
  {
    label: "different",
    content:
      "Decision: The dashboard should show overview and insights tabs with organization-scoped project navigation.",
  },
];

async function main() {
  await db.connect();

  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await db.query(
    `insert into projects(id, slug, name, visibility, org_id, owner_user_id, created_at, updated_at)
     values($1, $2, 'Cluster E2E', 'personal', null, $3, now(), now())`,
    [projectId, `cluster-${Date.now()}`, userId],
  );

  const created = [];
  for (const item of memories) {
    const row = await createMemory({ ...item, userId, projectId });
    created.push(row);
    console.log(`created ${item.label}`, JSON.stringify(row));
    await waitForMemory(row.memoryId);
  }

  const summary = await db.query(
    `select id, content, archived, superseded_by
       from memories
      where project_id = $1
      order by created_at`,
    [projectId],
  );
  const jobs = await db.query(
    `select memory_id, stage, status, result, error
       from agentic_jobs
      where project_id = $1
      order by created_at`,
    [projectId],
  );
  const episodes = await db.query(
    `select e.id, e.name, e.summary, e.member_count,
            array_agg(em.memory_id order by em.memory_id) as memory_ids
       from episodes e
       left join episode_memories em on em.episode_id = e.id
      where e.project_id = $1
      group by e.id
      order by e.created_at`,
    [projectId],
  );

  console.log("MEMORIES");
  console.log(JSON.stringify(summary.rows, null, 2));
  console.log("JOBS");
  console.log(JSON.stringify(jobs.rows, null, 2));
  console.log("EPISODES");
  console.log(JSON.stringify(episodes.rows, null, 2));
}

async function createMemory(input) {
  const memoryId = crypto.randomUUID();
  const inserted = await db.query(
    `insert into memories(
       id, org_id, project_id, owner_user_id, content, kind, visibility,
       confidence, importance, source_refs, created_at, updated_at
     ) values($1, null, $2, $3, $4, 'decision', 'project', 1, 0.8, $5::jsonb, now(), now())
     returning created_at::text as created_at, updated_at::text as updated_at`,
    [
      memoryId,
      input.projectId,
      input.userId,
      input.content,
      JSON.stringify([{ kind: "decision", ref: `cluster-e2e:${input.label}` }]),
    ],
  );
  const versionToken = inserted.rows[0].updated_at;
  await db.query(
    `insert into outbox_events(aggregate_type, aggregate_id, event_type, payload, created_at, next_attempt_at)
     values('memory', $1, 'memory.created', $2::jsonb, now(), now())`,
    [
      memoryId,
      JSON.stringify({
        memory_id: memoryId,
        project_id: input.projectId,
        org_id: null,
        owner_user_id: input.userId,
        kind: "decision",
        visibility: "project",
        content_length: input.content.length,
        source_refs: [{ kind: "decision", ref: `cluster-e2e:${input.label}` }],
        created_at: inserted.rows[0].created_at,
        updated_at: versionToken,
      }),
    ],
  );
  return { label: input.label, memoryId, versionToken };
}

async function waitForMemory(memoryId) {
  for (let i = 0; i < 120; i += 1) {
    const rows = await db.query(
      `select stage, status, result, error
         from agentic_jobs
        where memory_id = $1
        order by created_at`,
      [memoryId],
    );
    const stages = rows.rows;
    const hasTriageDone = stages.some((row) => row.stage === "triage" && row.status === "done");
    const hasEpisodeDoneOrSkipped = stages.some(
      (row) => row.stage === "episode" && ["done", "failed"].includes(row.status),
    );
    const archived = await db.query("select archived from memories where id = $1", [memoryId]);
    if (hasTriageDone && (hasEpisodeDoneOrSkipped || archived.rows[0]?.archived)) {
      return;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for memory ${memoryId}`);
}

try {
  await main();
} finally {
  await db.end().catch(() => undefined);
}
