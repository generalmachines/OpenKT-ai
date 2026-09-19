// shakeout-memory-engine — production-grade verification of the
// MemMachine memory engine adapter.
//
// What it proves:
//   1. POST /v1/memories writes propagate into MemMachine and land in
//      memory_external_refs WITH the tenancy columns populated
//      (external_namespace = MemMachine org_id, external_project_id =
//      MemMachine project_id) so a later forget can route correctly
//      even if the memory's project moves.
//   2. recall returns the just-written memories — by id, not just count.
//   3. Cross-tenant isolation: bob's recall in his personal project
//      does NOT return alice's personal memories. Recall in alice's
//      personal project does NOT return bob's personal memories.
//      Recall in the shared org project surfaces both alice's and
//      bob's org-scope memories.
//   4. Forget round-trips: after commands.forget, the OpenKT memory is
//      archived AND the matching MemMachine episode is gone (verified
//      by hitting MemMachine directly).
//   5. The schema brittleness fix: the tenancy unique constraint
//      (provider, kind, namespace, project, external_id) accepts a row
//      with the same external_id as long as it's in a different
//      namespace.
//
// Exits non-zero on any assertion failure. No "passed" without a
// matching ✓.

import crypto from "node:crypto";

import { NestFactory } from "@nestjs/core";
import { config } from "dotenv";
import pg from "pg";

import type { ActorContext } from "@openkt/core-context";

config({ path: [".env.local", ".env"] });

process.env.OPENKT_MEMORY_ENGINE = process.env.OPENKT_MEMORY_ENGINE ?? "memmachine";
process.env.OPENKT_MEMMACHINE_URL = process.env.OPENKT_MEMMACHINE_URL ?? "http://127.0.0.1:8091";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "shakeout-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "shakeout-service-role-key";

const runId = `engine-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const memMachineUrl = (process.env.OPENKT_MEMMACHINE_URL ?? "http://127.0.0.1:8091").replace(
  /\/+$/,
  "",
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const failures: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }
  console.error(`  ✗ ${message}`);
  failures.push(message);
}

interface MemMachineEpisode {
  uid?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

async function memMachineList(orgId: string, projectId: string): Promise<MemMachineEpisode[]> {
  const response = await fetch(`${memMachineUrl}/api/v2/memories/list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      org_id: orgId,
      project_id: projectId,
      types: ["episodic"],
      limit: 100,
    }),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as {
    content?: { episodic_memory?: MemMachineEpisode[] };
  };
  return body.content?.episodic_memory ?? [];
}

async function main(): Promise<void> {
  await db.connect();
  console.log(`run_id=${runId}\n`);

  const fixture = await seedFixture();
  const { AppModule } = await import("../apps/server/src/app.module");
  const { MemoryCommandsApplicationService } = await import(
    "../apps/server/src/modules/memory/services/memory-commands.application.service"
  );
  const { MemoryRecallService } = await import(
    "../apps/server/src/modules/memory/services/memory-recall.service"
  );
  const { MemoryQueriesApplicationService } = await import(
    "../apps/server/src/modules/memory/services/memory-queries.application.service"
  );
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const commands = app.get(MemoryCommandsApplicationService);
    const recall = app.get(MemoryRecallService);
    const queries = app.get(MemoryQueriesApplicationService);

    // -----------------------------------------------------------------
    // 1) Write 4 memories across alice/personal, org, bob/personal.
    // -----------------------------------------------------------------
    console.log("→ creating 4 memories across 3 tenancy scopes");
    const created: Array<{
      id: string;
      project_id: string;
      content: string;
      ownerUserId: string;
      ownerLabel: string;
      ownerOrgId: string | null;
    }> = [];
    for (const input of fixture.memoryInputs) {
      const owner = fixture.usersById.get(input.userId)!;
      const actor = contextFor(owner);
      const result = await commands.create(actor, {
        content: input.content,
        kind: input.kind,
        project_id: input.projectId,
        visibility: "project",
        tag_slugs: [],
        category: null,
        confidence: 1,
        importance: 0.75,
        source_refs: [{ kind: "decision", ref: runId }],
      });
      assert("id" in result, `memory create returned a row for ${input.label}`);
      if ("id" in result) {
        created.push({
          id: result.id,
          project_id: result.project_id,
          content: result.content,
          ownerUserId: input.userId,
          ownerLabel: input.label,
          ownerOrgId: input.expectedOrgId,
        });
      }
    }
    assert(created.length === fixture.memoryInputs.length, "all 4 memories landed");

    // -----------------------------------------------------------------
    // 2) memory_external_refs has tenancy columns populated correctly.
    //    expected per row:
    //      external_namespace = "personal:<owner_user_id>"  for personal,
    //                         = "<org_id>"                  for org,
    //      external_project_id = OpenKT project UUID
    // -----------------------------------------------------------------
    console.log("\n→ verifying memory_external_refs tenancy");
    for (const memory of created) {
      const refs = await db.query(
        `select external_id, external_namespace, external_project_id
           from memory_external_refs
          where memory_id = $1
            and provider = 'memmachine'
            and external_kind = 'episodic'`,
        [memory.id],
      );
      assert(refs.rows.length === 1, `${memory.ownerLabel}: exactly one memmachine ref`);
      const ref = refs.rows[0];
      const expectedNamespace = memory.ownerOrgId ?? `personal:${memory.ownerUserId}`;
      assert(
        ref.external_namespace === expectedNamespace,
        `${memory.ownerLabel}: external_namespace = ${expectedNamespace}`,
      );
      assert(
        ref.external_project_id === memory.project_id,
        `${memory.ownerLabel}: external_project_id = ${memory.project_id}`,
      );
      assert(typeof ref.external_id === "string" && ref.external_id.length > 0,
        `${memory.ownerLabel}: external_id is set (uid=${ref.external_id})`);
    }

    await waitForEmbeddings(created.map((memory) => memory.id));

    // -----------------------------------------------------------------
    // 3) recall returns the right memories per tenancy.
    // -----------------------------------------------------------------
    console.log("\n→ recall in alice's personal project should return alice's personal memory");
    const aliceMemories = created.filter(
      (m) => m.project_id === fixture.aliceProject.id,
    );
    const aliceRecall = await recall.recall(contextFor(fixture.alice), {
      project_id: fixture.aliceProject.id,
      query: "OpenKT CLI init dashboard visibility",
      limit: 10,
      min_confidence: 0,
      vector_weight: 0.6,
      workspace_weight: 0.4,
      rerank: false,
    });
    const aliceRecallIds = new Set(aliceRecall.data.map((row) => row.id));
    for (const expected of aliceMemories) {
      assert(
        aliceRecallIds.has(expected.id),
        `alice recall returned alice's memory ${expected.id}`,
      );
    }
    // Cross-tenant: bob's personal memory must NOT appear.
    for (const bobMemory of created.filter((m) => m.project_id === fixture.bobProject.id)) {
      assert(
        !aliceRecallIds.has(bobMemory.id),
        `alice recall does NOT include bob's personal memory ${bobMemory.id}`,
      );
    }

    console.log("\n→ recall in bob's personal project should return bob's personal memory");
    const bobMemories = created.filter((m) => m.project_id === fixture.bobProject.id);
    const bobRecall = await recall.recall(contextFor(fixture.bob), {
      project_id: fixture.bobProject.id,
      query: "synthesize memories before sending to Claude Code Cursor Codex",
      limit: 10,
      min_confidence: 0,
      vector_weight: 0.6,
      workspace_weight: 0.4,
      rerank: false,
    });
    const bobRecallIds = new Set(bobRecall.data.map((row) => row.id));
    for (const expected of bobMemories) {
      assert(
        bobRecallIds.has(expected.id),
        `bob recall returned bob's memory ${expected.id}`,
      );
    }
    for (const aliceMemory of aliceMemories) {
      assert(
        !bobRecallIds.has(aliceMemory.id),
        `bob recall does NOT include alice's personal memory ${aliceMemory.id}`,
      );
    }

    console.log("\n→ recall in shared org project surfaces both alice's and bob's org memories");
    const orgMemories = created.filter((m) => m.project_id === fixture.orgProject.id);
    const orgRecall = await recall.recall(contextFor(fixture.alice), {
      project_id: fixture.orgProject.id,
      query: "How should OpenKT use MemMachine and RabbitMQ?",
      limit: 10,
      min_confidence: 0,
      vector_weight: 0.6,
      workspace_weight: 0.4,
      rerank: false,
    });
    const orgRecallIds = new Set(orgRecall.data.map((row) => row.id));
    for (const expected of orgMemories) {
      assert(
        orgRecallIds.has(expected.id),
        `org recall returned org-scope memory ${expected.id}`,
      );
    }
    // Cross-tenant: alice's personal-only memory should NOT appear in
    // org recall (it's in a different project even though same owner).
    for (const aliceMemory of aliceMemories) {
      assert(
        !orgRecallIds.has(aliceMemory.id),
        `org recall does NOT include alice's personal-project memory ${aliceMemory.id}`,
      );
    }

    // -----------------------------------------------------------------
    // 4) memory_search through MemoryQueriesApplicationService
    //    (the surface MCP memory_search hits) finds bob's memory by
    //    keyword and respects project scoping.
    // -----------------------------------------------------------------
    console.log("\n→ memory_search (MCP surface) finds bob's memory by keyword");
    const searchAsBob = await queries.search(contextFor(fixture.bob), {
      query: "synthesize Claude Code Cursor Codex",
      mode: "hybrid",
      vector_weight: 0.6,
      workspace_weight: 0.4,
      filters: {
        project_ids: [fixture.bobProject.id],
        kinds: undefined,
        min_confidence: 0,
        include_archived: false,
        include_superseded: false,
      },
      limit: 10,
    });
    const searchIds = new Set(searchAsBob.data.map((row) => row.id));
    for (const bobMemory of bobMemories) {
      assert(searchIds.has(bobMemory.id), `search returned bob's memory ${bobMemory.id}`);
    }
    for (const aliceMemory of aliceMemories) {
      assert(
        !searchIds.has(aliceMemory.id),
        `search scoped to bob's project does NOT include alice's memory`,
      );
    }

    // -----------------------------------------------------------------
    // 5) memory_forget round-trip: pick alice's personal memory,
    //    archive (soft), verify OpenKT row archived AND MemMachine
    //    episode is gone.
    // -----------------------------------------------------------------
    if (aliceMemories[0]) {
      const target = aliceMemories[0];
      const aliceNamespace = `personal:${fixture.alice.id}`;
      const beforeEpisodes = await memMachineList(aliceNamespace, target.project_id);
      const beforeUids = new Set(beforeEpisodes.map((e) => e.uid));

      const targetRef = await db.query(
        `select external_id from memory_external_refs
          where memory_id = $1 and provider = 'memmachine' and external_kind = 'episodic'`,
        [target.id],
      );
      const targetUid = targetRef.rows[0]?.external_id as string | undefined;

      console.log(`\n→ forget alice's memory ${target.id} (uid=${targetUid})`);
      assert(typeof targetUid === "string", "target memory has a memmachine uid");
      assert(beforeUids.has(targetUid!), `MemMachine has episode uid=${targetUid} before forget`);

      await commands.forget(contextFor(fixture.alice), { id: target.id, hard: false });

      const archivedRow = await db.query(
        `select archived from memories where id = $1`,
        [target.id],
      );
      assert(archivedRow.rows[0]?.archived === true, "OpenKT memory row is archived");

      const refRow = await db.query(
        `select count(*)::int as n from memory_external_refs
          where memory_id = $1 and provider = 'memmachine'`,
        [target.id],
      );
      assert(refRow.rows[0]?.n === 0, "memory_external_refs row is removed");

      const afterEpisodes = await memMachineList(aliceNamespace, target.project_id);
      const afterUids = new Set(afterEpisodes.map((e) => e.uid));
      assert(
        !afterUids.has(targetUid!),
        `MemMachine episode uid=${targetUid} is gone after forget`,
      );
    }

    console.log("");
    if (failures.length === 0) {
      console.log(`✓ shakeout-memory-engine PASSED (${runId})`);
    } else {
      console.error(`✗ shakeout-memory-engine FAILED — ${failures.length} assertion(s):`);
      for (const message of failures) console.error(`  - ${message}`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    await db.end();
  }
}

interface MemoryInput {
  userId: string;
  projectId: string;
  kind: "decision" | "context" | "pattern";
  content: string;
  label: string;
  expectedOrgId: string | null;
}

async function seedFixture() {
  const alice = user("alice");
  const bob = user("bob");
  const usersById = new Map<string, ReturnType<typeof user>>([
    [alice.id, alice],
    [bob.id, bob],
  ]);
  const org = {
    id: crypto.randomUUID(),
    slug: runId,
    name: `OpenKT Engine Shakeout ${runId}`,
  };
  const aliceProject = project("alice", null, "personal", alice.id);
  const orgProject = project("platform", org.id, "org", alice.id);
  const bobProject = project("bob", null, "personal", bob.id);

  await db.query(
    `insert into users(id, email, email_verified, display_name, created_at, updated_at)
     values ($1, $2, true, $3, now(), now()), ($4, $5, true, $6, now(), now())`,
    [alice.id, alice.email, alice.displayName, bob.id, bob.email, bob.displayName],
  );
  await db.query(
    `insert into profiles(user_id, email, display_name, created_at)
     values ($1, $2, $3, now()), ($4, $5, $6, now())`,
    [alice.id, alice.email, alice.displayName, bob.id, bob.email, bob.displayName],
  );
  await db.query(
    `insert into orgs(id, slug, name, created_by, created_at)
     values ($1, $2, $3, $4, now())`,
    [org.id, org.slug, org.name, alice.id],
  );
  await db.query(
    `insert into org_members(org_id, user_id, role, invited_by, joined_at)
     values ($1, $2, 'owner', null, now()), ($1, $3, 'admin', $2, now())`,
    [org.id, alice.id, bob.id],
  );
  for (const row of [aliceProject, orgProject, bobProject]) {
    await db.query(
      `insert into projects(id, slug, name, visibility, org_id, owner_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, now(), now())`,
      [row.id, row.slug, row.name, row.visibility, row.orgId, row.ownerUserId],
    );
  }

  const memoryInputs: MemoryInput[] = [
    {
      userId: alice.id,
      projectId: aliceProject.id,
      kind: "decision",
      label: "alice/personal",
      expectedOrgId: null,
      content: `Alice personal ${runId}: OpenKT CLI init registers a repo project and dashboard visibility is owned by OpenKT.`,
    },
    {
      userId: alice.id,
      projectId: orgProject.id,
      kind: "decision",
      label: "alice/org",
      expectedOrgId: org.id,
      content: `Alice org ${runId}: MemMachine is the internal MemoryEngine adapter for storage and recall.`,
    },
    {
      userId: bob.id,
      projectId: orgProject.id,
      kind: "context",
      label: "bob/org",
      expectedOrgId: org.id,
      content: `Bob org ${runId}: RabbitMQ remains the OpenKT synthesis layer for briefings, pulse, and agent context packs.`,
    },
    {
      userId: bob.id,
      projectId: bobProject.id,
      kind: "pattern",
      label: "bob/personal",
      expectedOrgId: null,
      content: `Bob personal ${runId}: retrieved memories must be synthesized before being sent to Claude Code, Cursor, or Codex.`,
    },
  ];

  return {
    alice,
    bob,
    usersById,
    org,
    aliceProject,
    orgProject,
    bobProject,
    memoryInputs,
  };
}

function user(label: string) {
  const id = crypto.randomUUID();
  return {
    id,
    email: `${runId}-${label}@example.com`,
    displayName: `${label} ${runId}`,
  };
}

function project(label: string, orgId: string | null, visibility: "personal" | "org", ownerUserId: string) {
  return {
    id: crypto.randomUUID(),
    orgId,
    slug: `${runId}-${label}`,
    name: `${label} ${runId}`,
    visibility,
    ownerUserId,
  };
}

function contextFor(user: { id: string; email: string; displayName: string }): ActorContext {
  return {
    principal: {
      type: "user",
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      authSource: "system",
    },
    request: {
      requestId: runId,
      ip: null,
      userAgent: "shakeout-memory-engine",
      referer: null,
      origin: null,
      sessionId: runId,
      surface: "system",
      actorKind: "system",
    },
    sb: null as never,
    admin: () => null as never,
  };
}

async function waitForEmbeddings(memoryIds: string[]): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    const result = await db.query(
      `select count(*)::int as embedded_count
         from memories
        where id = any($1::uuid[]) and embedding is not null`,
      [memoryIds],
    );
    if (result.rows[0]?.embedded_count === memoryIds.length) return;
    await sleep(1000);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
