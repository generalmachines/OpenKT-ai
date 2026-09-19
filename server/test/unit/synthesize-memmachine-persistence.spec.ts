// Persistence pin for MemMachine data captured during synthesize.
//
// Until 2026-05-15 the synthesize stage called MemMachine only via the
// thin `findCandidates` bridge that throws away everything except the
// (openkt_memory_id, similarity) pair — so the rich MemMachine
// response (episodic uids, canonical statements, semantic items) flew
// past us on the floor. After this change, when MemMachine is enabled
// the synthesize stage MUST persist one row per MemMachine node into
// `memmachine_nodes`, scoped to the memory that triggered the run.
//
// These tests pin three properties:
//   1. when MemMachine is disabled / returns nothing, no rows are written
//   2. when MemMachine returns episodic + semantic items, both get
//      persisted with their kind + statement + external_id
//   3. the upsert is idempotent: running twice for the same memory does
//      not produce duplicate rows (the unique key is
//      (memory_id, node_kind, external_id))
//
// Like the other worker unit specs in this folder, this is a pure unit
// test against a FakePg + a fake MemMachineBridgeService — no real
// Postgres, no real HTTP.

import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

interface PgCall {
  sql: string;
  params: unknown[];
}

class FakePg {
  public calls: PgCall[] = [];
  public oneResults: Array<unknown> = [];
  public queryResults: Array<unknown[]> = [];
  // Track inserts to memmachine_nodes so tests can assert exact rows.
  public memmachineInserts: Array<Record<string, unknown>> = [];

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, params });
    if (/insert\s+into\s+memmachine_nodes/i.test(sql)) {
      this.memmachineInserts.push({ sql, params });
      // Simulate `returning id` so the upsert call resolves.
      return { id: `mm-${this.memmachineInserts.length}` } as T;
    }
    const next = this.oneResults.shift();
    return (next as T | undefined) ?? null;
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, params });
    if (/insert\s+into\s+memmachine_nodes/i.test(sql)) {
      this.memmachineInserts.push({ sql, params });
      return [] as T[];
    }
    const next = this.queryResults.shift();
    return (next as T[] | undefined) ?? [];
  }
}

function memoryRow(): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000aaa",
    content: "decision: roll back v2 release",
    kind: "decision",
    project_id: "00000000-0000-0000-0000-000000000bbb",
    org_id: "00000000-0000-0000-0000-000000000ccc",
    owner_user_id: "00000000-0000-0000-0000-000000000ddd",
    archived: false,
    superseded_by: null,
    updated_at: "2026-05-15T00:00:00.000Z",
    embedding: `[${new Array(1024).fill(0.1).join(",")}]`,
  };
}

function makeMessage(
  overrides: Partial<PipelineCommandMessage> = {},
): PipelineCommandMessage {
  return {
    message_id: "msg-1",
    correlation_id: "corr-1",
    causation_id: null,
    job_type: "memory.synthesize",
    aggregate_type: "memory",
    aggregate_id: "00000000-0000-0000-0000-000000000aaa",
    project_id: "00000000-0000-0000-0000-000000000bbb",
    org_id: "00000000-0000-0000-0000-000000000ccc",
    user_id: "00000000-0000-0000-0000-000000000ddd",
    version_token: "2026-05-15T00:00:00.000Z",
    payload: {},
    published_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

interface BuildArgs {
  llmObject?: {
    action: "create" | "extend" | "supersede" | "fork" | "skip";
    new_summary?: string;
    superseded_memory_ids?: string[];
    confidence?: number;
    reason?: string;
  };
  memMachineNodes?: Array<{
    nodeKind: "episodic" | "semantic" | "relation";
    externalId: string | null;
    statement: string | null;
    subject?: string | null;
    predicate?: string | null;
    object?: string | null;
    score?: number | null;
    metadata?: Record<string, unknown>;
  }>;
  memMachineEnabled?: boolean;
}

function buildStage(pg: FakePg, args: BuildArgs = {}) {
  const {
    SynthesizeStageService,
  } = require("../../apps/worker/src/modules/memory-engine/services/synthesize-stage.service");

  const llmObject = args.llmObject ?? {
    action: "create",
    new_summary: "Decision: rolled back v2 release.",
    superseded_memory_ids: [],
    confidence: 0.95,
    reason: "first observation of this topic",
  };

  const gateway = {
    tryGenerateObject: jest.fn(async () => ({
      object: llmObject,
      provider: "openrouter",
      model: "fake-test-model",
    })),
  };
  const resolver = { resolve: jest.fn(async () => null) };
  const memMachine = {
    isEnabled: jest.fn(() => args.memMachineEnabled ?? false),
    namespace: jest.fn((m: { org_id: string | null; project_id: string; owner_user_id: string }) => ({
      orgId: m.org_id ?? `personal:${m.owner_user_id}`,
      projectId: m.project_id,
    })),
    findCandidates: jest.fn(async () => []),
    fetchMemoryGraph: jest.fn(async () => args.memMachineNodes ?? []),
  };
  const config = { get: jest.fn(() => undefined) };
  return {
    stage: new SynthesizeStageService(pg, gateway, resolver, memMachine, config),
    memMachine,
  };
}

// Common pre-flight queries the synthesize stage runs in order:
//   1. one() memory row
//   2. query() tags (memory_tags join)
//   3. query() findRelatedMemories — pgvector branch returns []
//   4. one() existing episode lookup
//   5. (LLM call — mocked)
//   6. one() insert into episodes returning id
//   7. query() insert into episode_memories
//   8+ memmachine_nodes persistence calls — what we're pinning
function primePg(pg: FakePg) {
  pg.oneResults.push(memoryRow());
  pg.queryResults.push([{ slug: "decision" }, { slug: "v2-rollback" }]);
  pg.queryResults.push([]); // findRelatedMemories — pgvector branch, empty
  pg.oneResults.push(null); // findExistingEpisode — none
  pg.oneResults.push({ id: "ep-1" }); // insert episode returning id
  pg.queryResults.push([]); // insert episode_memories
}

describe("Synthesize stage MemMachine persistence", () => {
  it("does NOT touch memmachine_nodes when MemMachine bridge is disabled", async () => {
    const pg = new FakePg();
    primePg(pg);
    const { stage } = buildStage(pg, { memMachineEnabled: false });

    const result = await stage.execute(makeMessage());

    expect(result.result.action).toBe("create");
    expect(pg.memmachineInserts).toHaveLength(0);
  });

  it("persists every MemMachine node returned for the synthesized memory", async () => {
    const pg = new FakePg();
    primePg(pg);
    const { stage, memMachine } = buildStage(pg, {
      memMachineEnabled: true,
      memMachineNodes: [
        {
          nodeKind: "episodic",
          externalId: "mm-uid-episodic-1",
          statement: "User decided to roll back v2 release at 14:02 UTC.",
          score: 0.91,
          metadata: { producer: "cc2@tenxor.sh" },
        },
        {
          nodeKind: "semantic",
          externalId: "mm-uid-semantic-1",
          statement: "v2 release was rolled back",
          score: 0.84,
        },
        {
          nodeKind: "relation",
          externalId: null,
          statement: null,
          subject: "user",
          predicate: "decided",
          object: "rollback v2",
          score: null,
        },
      ],
    });

    const result = await stage.execute(makeMessage());

    expect(result.result.action).toBe("create");
    expect(memMachine.fetchMemoryGraph).toHaveBeenCalledTimes(1);
    expect(pg.memmachineInserts).toHaveLength(3);

    // The inserts should pass through node_kind + statement + external_id
    // in their parameter arrays. We don't pin column order tightly (the
    // service controls that), only that the values reach the SQL layer.
    // Note: relation-without-uid rows hardcode 'relation' as a SQL literal
    // (so it can't show up here) — we assert on subject/predicate/object
    // instead, which DO travel as bound params.
    const allParams = pg.memmachineInserts.flatMap((row) => row.params as unknown[]);
    expect(allParams).toContain("episodic");
    expect(allParams).toContain("semantic");
    expect(allParams).toContain("mm-uid-episodic-1");
    expect(allParams).toContain("mm-uid-semantic-1");
    expect(allParams).toContain("User decided to roll back v2 release at 14:02 UTC.");
    expect(allParams).toContain("v2 release was rolled back");
    // Relation row: subject/predicate/object reach SQL as bound params.
    expect(allParams).toContain("user");
    expect(allParams).toContain("decided");
    expect(allParams).toContain("rollback v2");

    // Each kind landed in its own SQL — assert by SQL fragment so we
    // also pin the upsert wiring used per branch.
    const sqls = pg.memmachineInserts.map((row) => String(row.sql).toLowerCase());
    expect(sqls.some((s) => s.includes("memory_id, node_kind, external_id"))).toBe(true);
    expect(sqls.some((s) => s.includes("'relation'") && s.includes("(memory_id, subject, predicate, object)"))).toBe(true);
  });

  it("uses on-conflict upsert SQL so re-running synthesize is idempotent", async () => {
    const pg = new FakePg();
    primePg(pg);
    buildStage(pg, {
      memMachineEnabled: true,
      memMachineNodes: [
        {
          nodeKind: "episodic",
          externalId: "mm-uid-1",
          statement: "canonical statement",
        },
      ],
    }).stage.execute(makeMessage());

    // Wait for the microtask queue to drain so the persistence call lands.
    await new Promise((resolve) => setImmediate(resolve));

    expect(pg.memmachineInserts.length).toBeGreaterThan(0);
    const sql = String(pg.memmachineInserts[0].sql).toLowerCase();
    expect(sql).toContain("on conflict");
    expect(sql).toContain("memmachine_nodes");
  });

  it("does not write rows when MemMachine bridge returns an empty graph", async () => {
    const pg = new FakePg();
    primePg(pg);
    const { stage, memMachine } = buildStage(pg, {
      memMachineEnabled: true,
      memMachineNodes: [],
    });

    const result = await stage.execute(makeMessage());

    expect(result.result.action).toBe("create");
    expect(memMachine.fetchMemoryGraph).toHaveBeenCalledTimes(1);
    expect(pg.memmachineInserts).toHaveLength(0);
  });

  it("does not fail the stage if MemMachine bridge throws — persistence is best-effort", async () => {
    const pg = new FakePg();
    primePg(pg);

    const {
      SynthesizeStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/synthesize-stage.service");
    const gateway = {
      tryGenerateObject: jest.fn(async () => ({
        object: {
          action: "create",
          new_summary: "ok",
          superseded_memory_ids: [],
          confidence: 0.9,
          reason: "ok",
        },
        provider: "openrouter",
        model: "fake-test-model",
      })),
    };
    const resolver = { resolve: jest.fn(async () => null) };
    const memMachine = {
      isEnabled: () => true,
      namespace: (m: { org_id: string | null; project_id: string; owner_user_id: string }) => ({
        orgId: m.org_id ?? `personal:${m.owner_user_id}`,
        projectId: m.project_id,
      }),
      findCandidates: jest.fn(async () => []),
      fetchMemoryGraph: jest.fn(async () => {
        throw new Error("memmachine offline");
      }),
    };
    const config = { get: jest.fn(() => undefined) };
    const stage = new SynthesizeStageService(pg, gateway, resolver, memMachine, config);

    const result = await stage.execute(makeMessage());

    expect(result.result.action).toBe("create");
    expect(pg.memmachineInserts).toHaveLength(0);
  });
});
