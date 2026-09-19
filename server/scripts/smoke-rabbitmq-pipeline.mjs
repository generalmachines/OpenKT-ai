#!/usr/bin/env node
import crypto from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: [".env.local", ".env"] });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await db.connect();

  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const memoryId = crypto.randomUUID();
  const now = new Date().toISOString();
  const content = `OpenKT controlled RabbitMQ pipeline proof ${now}`;

  await db.query(
    `insert into projects(id, slug, name, visibility, org_id, owner_user_id, created_at, updated_at)
     values($1, $2, $3, 'personal', null, $4, now(), now())`,
    [projectId, `e2e-${Date.now()}`, "E2E Pipeline", userId],
  );

  const inserted = await db.query(
    `insert into memories(
       id, org_id, project_id, owner_user_id, content, kind, visibility,
       confidence, importance, source_refs, created_at, updated_at
     ) values($1, null, $2, $3, $4, 'note', 'project', 1, 0.7, $5::jsonb, now(), now())
     returning created_at::text as created_at, updated_at::text as updated_at`,
    [
      memoryId,
      projectId,
      userId,
      content,
      JSON.stringify([{ kind: "decision", ref: "controlled-e2e" }]),
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
        project_id: projectId,
        org_id: null,
        owner_user_id: userId,
        kind: "note",
        visibility: "project",
        content_length: content.length,
        source_refs: [{ kind: "decision", ref: "controlled-e2e" }],
        created_at: inserted.rows[0].created_at,
        updated_at: versionToken,
      }),
    ],
  );

  console.log(JSON.stringify({ userId, projectId, memoryId }));

  for (let i = 0; i < 90; i += 1) {
    const outbox = await db.query(
      "select published_at, attempts, last_error from outbox_events where aggregate_id = $1",
      [memoryId],
    );
    const jobs = await db.query(
      `select stage, status, attempts, error, result
       from agentic_jobs
       where memory_id = $1
          or (project_id = $2 and created_at >= $3::timestamptz)
       order by created_at`,
      [memoryId, projectId, now],
    );

    const done = (stage) =>
      jobs.rows.some((row) => row.stage === stage && row.status === "done");
    const failed = jobs.rows.filter((row) => row.status === "failed");
    const embedJob = jobs.rows.find((row) => row.stage === "embed");
    const embedOk =
      embedJob?.status === "done" &&
      (process.env.OPENKT_MEMORY_ENGINE === "memmachine"
        ? embedJob.result?.skipped === true &&
          embedJob.result?.reason === "embedding owned by memmachine"
        : true);
    const pulseOk = jobs.rows.some(
      (row) =>
        row.stage === "pulse" &&
        row.status === "done" &&
        row.result?.generated === true,
    );
    const briefingOk = jobs.rows.some(
      (row) =>
        row.stage === "briefing" &&
        row.status === "done" &&
        (row.result?.generated === true || row.result?.skipped === true),
    );
    const state = {
      published: Boolean(outbox.rows[0]?.published_at),
      embedOk,
      pulseOk,
      briefingOk,
      outbox: outbox.rows[0] ?? null,
      jobs: jobs.rows,
    };

    if (i % 5 === 0) {
      console.log(`poll ${i}`, JSON.stringify(state));
    }

    if (
      state.published &&
      failed.length === 0 &&
      done("preprocess") &&
      embedOk &&
      done("triage") &&
      done("episode") &&
      pulseOk &&
      briefingOk
    ) {
      console.log("PASS", JSON.stringify(state));
      return;
    }

    await sleep(1000);
  }

  const allJobs = await db.query(
    `select * from agentic_jobs
     where memory_id = $1
        or (project_id = $2 and created_at >= $3::timestamptz)
     order by created_at`,
    [memoryId, projectId, now],
  );
  console.log("TIMEOUT");
  console.log(JSON.stringify(allJobs.rows, null, 2));
  process.exitCode = 1;
}

try {
  await main();
} finally {
  await db.end().catch(() => undefined);
}
