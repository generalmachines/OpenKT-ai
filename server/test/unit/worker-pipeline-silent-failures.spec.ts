// Regression tests for the 5 silent-failure bugs in the worker
// pipeline (see fix/worker-pipeline-silent-failures branch).
//
// These specs do NOT spin up Nest. Each stage service is constructed
// directly with hand-rolled fakes for `WorkerPgService` (the worker's
// plain pg pool wrapper), `LlmGatewayService`, and the
// `WorkerLlmConfigResolverService`. The point is to pin the SQL
// strings / argument vectors / fan-out shape — anything that the
// silent-failure bugs got wrong and that prod-style integration tests
// would only catch after a deploy.

import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

// ── Test doubles ─────────────────────────────────────────────────────

interface PgCall {
  sql: string;
  params: unknown[];
}

class FakePg {
  public calls: PgCall[] = [];
  // queueOne / queueQuery let a test seed the result of each pg call
  // in order. If the test doesn't seed a row, both methods return null
  // / [] respectively — matching the real `WorkerPgService` semantics.
  public oneResults: Array<unknown> = [];
  public queryResults: Array<unknown[]> = [];

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, params });
    const next = this.oneResults.shift();
    return (next as T | undefined) ?? null;
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, params });
    const next = this.queryResults.shift();
    return (next as T[] | undefined) ?? [];
  }

  /** Find the first sql that matches a substring — handy for assertions. */
  findCall(needle: string): PgCall | undefined {
    return this.calls.find((c) => c.sql.includes(needle));
  }
  findAllCalls(needle: string): PgCall[] {
    return this.calls.filter((c) => c.sql.includes(needle));
  }
}

function makeMessage(
  overrides: Partial<PipelineCommandMessage> = {},
): PipelineCommandMessage {
  return {
    message_id: "msg-1",
    correlation_id: "corr-1",
    causation_id: null,
    job_type: "memory.preprocess",
    aggregate_type: "memory",
    aggregate_id: "00000000-0000-0000-0000-000000000aaa",
    project_id: "00000000-0000-0000-0000-000000000bbb",
    org_id: null,
    user_id: "00000000-0000-0000-0000-000000000ccc",
    version_token: "2026-05-14T00:00:00.000Z",
    payload: {},
    published_at: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

// ── Bug 1: embed stage writes `memories.embedding` ALWAYS ────────────

describe("EmbedStageService — bug 1: writes memories.embedding even when one exists", () => {
  // The embed module reads its backend off process.env at import time
  // (top of `embedding-bge.ts`). We use the `bge` path and stub
  // `global.fetch` so the embed() helper returns a 1024-dim vector
  // without needing a TEI instance.
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_BACKEND = process.env.OPENKT_EMBEDDING_BACKEND;

  beforeAll(() => {
    process.env.OPENKT_EMBEDDING_BACKEND = "bge";
  });
  afterAll(() => {
    if (ORIGINAL_BACKEND === undefined) {
      delete process.env.OPENKT_EMBEDDING_BACKEND;
    } else {
      process.env.OPENKT_EMBEDDING_BACKEND = ORIGINAL_BACKEND;
    }
    global.fetch = ORIGINAL_FETCH;
  });

  beforeEach(() => {
    const vector = new Array(1024).fill(0).map((_, i) => i / 1024);
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify([vector]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
  });

  it("calls UPDATE memories SET embedding even when the row already had one", async () => {
    const {
      EmbedStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/embed-stage.service");

    const pg = new FakePg();
    // Seed the first .one() (select the memory row) — note the row
    // looks like it already has an embedding present.
    pg.oneResults.push({
      id: "00000000-0000-0000-0000-000000000aaa",
      content: "hello world",
      project_id: "00000000-0000-0000-0000-000000000bbb",
      org_id: null,
      owner_user_id: "00000000-0000-0000-0000-000000000ccc",
      archived: false,
      updated_at: "2026-05-14T00:00:00.000Z",
    });
    // Seed the UPDATE returning row.
    pg.oneResults.push({ updated_at: "2026-05-14T00:00:00.500Z" });

    const stage = new EmbedStageService(pg);
    const message = makeMessage({ job_type: "memory.embed" });
    const result = await stage.execute(message);

    const update = pg.findCall("update memories");
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/set embedding\s*=\s*\$2::vector/);
    expect(result.result).toMatchObject({
      embedded: true,
      memory_id: "00000000-0000-0000-0000-000000000aaa",
    });
    // And it queued the single downstream command — triage. Neighbors
    // are no longer pre-computed per memory; the server computes them
    // lazily on first recall (see MemoryRecallService) and caches the
    // result in `memory_neighbors` for 24h.
    expect(result.commands?.length).toBe(1);
    const jobTypes = (result.commands ?? []).map(
      (c: PipelineCommandMessage) => c.job_type,
    ).sort();
    expect(jobTypes).toEqual(["memory.triage"]);
  });
});

// ── Bug 2: briefing stage writes to `project_briefing_cache` ─────────

describe("BriefingStageService — bug 2: writes project_briefing_cache, never team_briefings", () => {
  it("UPSERTs into project_briefing_cache on the success path", async () => {
    const {
      BriefingStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/briefing-stage.service");

    const pg = new FakePg();
    // 1) select project
    pg.oneResults.push({
      id: "00000000-0000-0000-0000-000000000bbb",
      name: "P",
      slug: "p",
      org_id: null,
    });
    // 2) select prior cache row
    pg.oneResults.push(null);
    // 3) recent memories
    pg.queryResults.push([
      {
        id: "00000000-0000-0000-0000-000000000aa1",
        content: "a memory",
        kind: "note",
        created_at: "2026-05-14T00:00:00.000Z",
      },
    ]);
    // 4) episodes
    pg.queryResults.push([]);
    // 5) total memory count
    pg.oneResults.push({ n: 1 });
    // 6) total episode count
    pg.oneResults.push({ n: 0 });
    // 7) upsert returning version
    pg.oneResults.push({ version: 1 });

    const fakeGateway = {
      tryGenerateObject: jest.fn(async () => ({
        object: {
          summary: "a brief",
          themes: [],
          key_decisions: [],
          open_questions: [],
        },
        provider: "minimax",
        model: "MiniMax-M2.7",
        meta: { fallbackUsed: false, providerChain: ["minimax", "openai"] },
      })),
      getCircuitBreaker: () => ({
        getState: () => "closed",
        getStats: () => ({ state: "closed", recentFailures: [], openedAt: null, lastError: null }),
      }),
    };
    const fakeResolver = { resolve: jest.fn(async () => null) };

    const stage = new BriefingStageService(pg, fakeGateway, fakeResolver);
    const message = makeMessage({
      job_type: "project.briefing",
      aggregate_type: "project",
      aggregate_id: "00000000-0000-0000-0000-000000000bbb",
    });
    const result = await stage.execute(message);

    const upsert = pg.findCall("insert into project_briefing_cache");
    expect(upsert).toBeDefined();
    // and NOT the legacy table
    expect(pg.findCall("team_briefings")).toBeUndefined();
    expect(pg.findCall("teamBriefings")).toBeUndefined();
    expect(result.result).toMatchObject({ generated: true });
  });

  it("writes a placeholder cache row when the LLM returns null", async () => {
    const {
      BriefingStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/briefing-stage.service");

    const pg = new FakePg();
    pg.oneResults.push({
      id: "00000000-0000-0000-0000-000000000bbb",
      name: "P",
      slug: "p",
      org_id: null,
    });
    pg.oneResults.push(null);
    pg.queryResults.push([
      {
        id: "00000000-0000-0000-0000-000000000aa1",
        content: "a memory",
        kind: "note",
        created_at: "2026-05-14T00:00:00.000Z",
      },
    ]);
    pg.queryResults.push([]);
    pg.oneResults.push({ n: 1 });
    pg.oneResults.push({ n: 0 });
    // No upsert oneResult — placeholder uses .query (no RETURNING).

    const fakeGateway = {
      tryGenerateObject: jest.fn(async () => null),
      getCircuitBreaker: () => ({
        getState: () => "open",
        getStats: () => ({
          state: "open",
          recentFailures: [Date.now()],
          openedAt: Date.now(),
          lastError: "503 from upstream",
        }),
      }),
    };
    const fakeResolver = { resolve: jest.fn(async () => null) };
    const stage = new BriefingStageService(pg, fakeGateway, fakeResolver);
    const message = makeMessage({
      job_type: "project.briefing",
      aggregate_type: "project",
      aggregate_id: "00000000-0000-0000-0000-000000000bbb",
    });
    const result = await stage.execute(message);

    const placeholder = pg.findCall("insert into project_briefing_cache");
    expect(placeholder).toBeDefined();
    expect(placeholder!.sql).toMatch(/\(not yet generated\)/);
    expect(result.result).toMatchObject({
      skipped: true,
      placeholder_written: true,
    });
  });
});

// ── Bug 3: member_knowledge upsert includes user_id ──────────────────

describe("MemberKnowledgeStageService — bug 3: user_id is in the INSERT column list", () => {
  it("upserts a row with user_id explicitly written, even on LLM failure", async () => {
    const {
      MemberKnowledgeStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/member-knowledge-stage.service");

    const pg = new FakePg();
    // 1) select project
    pg.oneResults.push({
      id: "00000000-0000-0000-0000-000000000bbb",
      name: "P",
      slug: "p",
      org_id: null,
    });
    // 2) findStaleContributors → one contributor
    pg.queryResults.push([
      {
        user_id: "00000000-0000-0000-0000-000000000ccc",
        display_name: "Alex",
        memory_count: 3,
        episode_count: 0,
        last_memory_at: "2026-05-14T00:00:00.000Z",
        last_synthesized_at: null,
      },
    ]);
    // 3) fetchMemoriesForContributor → 1 memory
    pg.queryResults.push([
      {
        id: "00000000-0000-0000-0000-000000000aa1",
        content: "first memory",
        kind: "note",
        created_at: "2026-05-14T00:00:00.000Z",
      },
    ]);
    // 4) upsert (LLM-failure placeholder path) returns nothing
    pg.queryResults.push([]);

    const fakeGateway = {
      tryGenerateText: jest.fn(async () => null),
    };
    const fakeResolver = { resolve: jest.fn(async () => null) };

    const stage = new MemberKnowledgeStageService(pg, fakeGateway, fakeResolver);
    const message = makeMessage({
      job_type: "memory.member_knowledge",
      aggregate_type: "project",
      aggregate_id: "00000000-0000-0000-0000-000000000bbb",
    });
    const result = await stage.execute(message);

    const upsert = pg.findCall("insert into member_knowledge");
    expect(upsert).toBeDefined();
    // user_id is the third column / third positional parameter
    expect(upsert!.sql).toMatch(/project_id,\s*org_id,\s*user_id/);
    expect(upsert!.params[2]).toBe("00000000-0000-0000-0000-000000000ccc");
    // Summary is null on the placeholder path
    expect(upsert!.params[3]).toBeNull();
    expect(result.result).toMatchObject({
      placeholders_written: 1,
      contributors_scanned: 1,
    });
  });

  it("findStaleContributors filters owner_user_id IS NULL", async () => {
    const {
      MemberKnowledgeStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/member-knowledge-stage.service");

    const pg = new FakePg();
    pg.queryResults.push([]);
    const stage = new MemberKnowledgeStageService(
      pg,
      { tryGenerateText: jest.fn(async () => null) },
      { resolve: jest.fn(async () => null) },
    );
    await stage.findStaleContributors(
      "00000000-0000-0000-0000-000000000bbb",
    );
    expect(pg.calls.length).toBe(1);
    expect(pg.calls[0].sql).toMatch(/m\.owner_user_id is not null/);
  });
});

// ── Bug 4: preprocess fan-out declares memory.synthesize ─────────────

describe("PreprocessStageService — per-memory fan-out is just `memory.embed`", () => {
  it("returns queued = [embed] (member_knowledge + briefing are cron-batched)", async () => {
    const {
      PreprocessStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/preprocess-stage.service");

    const pg = new FakePg();
    pg.oneResults.push({
      id: "00000000-0000-0000-0000-000000000aaa",
      project_id: "00000000-0000-0000-0000-000000000bbb",
      org_id: null,
      owner_user_id: "00000000-0000-0000-0000-000000000ccc",
      archived: false,
      updated_at: "2026-05-14T00:00:00.000Z",
    });

    const stage = new PreprocessStageService(pg);
    const result = await stage.execute(makeMessage());
    expect((result.result as { queued: string[] }).queued).toEqual([
      "memory.embed",
    ]);
    // Commands fan-out is exactly one entry (memory.embed). The
    // member_knowledge / briefing stages are no longer fanned out
    // per memory — those are batched by 5-minute cron services that
    // emit one job per project. Neighbors are now computed lazily on
    // recall and cached for 24h, so they're absent here as well.
    expect(result.commands).toHaveLength(1);
    expect(result.commands?.[0]?.job_type).toBe("memory.embed");
  });
});

// ── Bug 5: outbox relay catch persists last_error + dead-letters ─────

describe("OutboxRelayService — bug 5: catch block persists last_error", () => {
  // The relay imports rmq + config — instantiate via the class with
  // hand-rolled fakes that satisfy just the surface drainOnce uses.
  it("calls outboxStore.markFailed with the thrown error message", async () => {
    const {
      OutboxRelayService,
    } = require("../../apps/worker/src/modules/outbox/outbox-relay.service");

    const markFailed = jest.fn<
      Promise<boolean>,
      [string, string, string, string]
    >(async () => true);
    const outboxStore = {
      claimBatch: jest.fn(async () => [
        {
          id: "evt-1",
          aggregateType: "memory",
          aggregateId: "00000000-0000-0000-0000-000000000aaa",
          eventType: "memory.created",
          payload: {
            project_id: "00000000-0000-0000-0000-000000000bbb",
            owner_user_id: "00000000-0000-0000-0000-000000000ccc",
            updated_at: "2026-05-14T00:00:00.000Z",
          },
          publishedAt: null,
          attempts: 0,
          lastError: null,
          createdAt: "2026-05-14T00:00:00.000Z",
          nextAttemptAt: "2026-05-14T00:00:00.000Z",
          claimToken: "claim-1",
          claimedAt: "2026-05-14T00:00:00.000Z",
        },
      ]),
      markPublished: jest.fn(async () => true),
      markFailed,
    };

    const publisher = {
      publish: jest.fn(async () => {
        throw new Error("rabbit on fire");
      }),
    };
    const config = {
      get: (k: string) => (k === "NODE_ENV" ? "test" : undefined),
    };

    const relay = new OutboxRelayService(outboxStore, publisher, config);
    await relay.drainOnce();

    expect(markFailed).toHaveBeenCalledTimes(1);
    const callArgs = markFailed.mock.calls[0];
    expect(callArgs[2]).toBe("rabbit on fire");
  });

  it("dead-letters after attempts >= 20 (prefix + far-future nextAttemptAt)", async () => {
    const {
      OutboxRelayService,
    } = require("../../apps/worker/src/modules/outbox/outbox-relay.service");

    const markFailed = jest.fn<
      Promise<boolean>,
      [string, string, string, string]
    >(async () => true);
    const outboxStore = {
      claimBatch: jest.fn(async () => [
        {
          id: "evt-1",
          aggregateType: "memory",
          aggregateId: "00000000-0000-0000-0000-000000000aaa",
          eventType: "memory.created",
          payload: {
            project_id: "00000000-0000-0000-0000-000000000bbb",
            owner_user_id: "00000000-0000-0000-0000-000000000ccc",
            updated_at: "2026-05-14T00:00:00.000Z",
          },
          publishedAt: null,
          // 19 prior attempts; claimBatch incremented to 20 already
          attempts: 19,
          lastError: "previous failure",
          createdAt: "2026-05-14T00:00:00.000Z",
          nextAttemptAt: "2026-05-14T00:00:00.000Z",
          claimToken: "claim-1",
          claimedAt: "2026-05-14T00:00:00.000Z",
        },
      ]),
      markPublished: jest.fn(async () => true),
      markFailed,
    };

    const publisher = {
      publish: jest.fn(async () => {
        throw new Error("still broken");
      }),
    };
    const config = {
      get: (k: string) => (k === "NODE_ENV" ? "test" : undefined),
    };

    const relay = new OutboxRelayService(outboxStore, publisher, config);
    await relay.drainOnce();

    expect(markFailed).toHaveBeenCalledTimes(1);
    const callArgs = markFailed.mock.calls[0];
    const errorMessage = callArgs[2];
    const nextAttemptAt = callArgs[3];
    expect(errorMessage).toMatch(/^\[DEAD_LETTER\]/);
    expect(errorMessage).toMatch(/still broken/);
    // Far-future date — anything past year 2100 satisfies the contract.
    expect(Date.parse(nextAttemptAt)).toBeGreaterThan(
      Date.parse("2100-01-01T00:00:00.000Z"),
    );
  });
});
