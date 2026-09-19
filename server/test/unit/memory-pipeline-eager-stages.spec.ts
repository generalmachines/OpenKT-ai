// Unit test that pins the per-memory eager fan-out contract after the
// pipeline simplification push.
//
// The contract:
//   - preprocess emits exactly one command: `memory.embed`
//     (member_knowledge + briefing are batched per-project via a
//     5-minute cron; neighbors are computed lazily on recall)
//   - embed emits exactly one command: `memory.triage`
//   - triage emits `memory.episode` with `synthesize_eligible: false`
//     when no supersede was flagged
//   - triage emits `memory.episode` with `synthesize_eligible: true`
//     when a supersede was flagged
//   - episode emits `memory.synthesize` ONLY when the incoming payload
//     carries `synthesize_eligible: true`
//
// Together: a single un-noticeable memory (no supersede) lands on the
// queue and only fans out preprocess → embed → triage → episode.
// That's the 4 eager stages the user asked for.

import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

interface PgCall {
  sql: string;
  params: unknown[];
}

class FakePg {
  public calls: PgCall[] = [];
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

describe("Per-memory eager fan-out contract (preprocess → embed → triage → episode)", () => {
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

  it("preprocess emits exactly memory.embed — not member_knowledge, briefing, or neighbors", async () => {
    const {
      PreprocessStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/preprocess-stage.service");

    const pg = new FakePg();
    pg.oneResults.push({
      id: "mem-a",
      project_id: "proj-1",
      org_id: null,
      owner_user_id: "user-1",
      archived: false,
      updated_at: "2026-05-14T00:00:00.000Z",
    });

    const stage = new PreprocessStageService(pg);
    const result = await stage.execute(makeMessage({ aggregate_id: "mem-a" }));

    expect(result.commands).toHaveLength(1);
    expect(result.commands?.[0]?.job_type).toBe("memory.embed");

    const jobTypes = (result.commands ?? []).map(
      (c: PipelineCommandMessage) => c.job_type,
    );
    expect(jobTypes).not.toContain("memory.member_knowledge");
    expect(jobTypes).not.toContain("project.briefing");
    expect(jobTypes).not.toContain("memory.neighbors");
    expect(jobTypes).not.toContain("memory.synthesize");
  });

  it("embed emits exactly memory.triage — neighbors no longer fan out", async () => {
    const vector = new Array(1024).fill(0).map((_, i) => i / 1024);
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify([vector]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const {
      EmbedStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/embed-stage.service");

    const pg = new FakePg();
    pg.oneResults.push({
      id: "mem-a",
      content: "hello",
      project_id: "proj-1",
      org_id: null,
      owner_user_id: "user-1",
      archived: false,
      updated_at: "2026-05-14T00:00:00.000Z",
    });
    pg.oneResults.push({ updated_at: "2026-05-14T00:00:00.500Z" });

    const stage = new EmbedStageService(pg);
    const result = await stage.execute(
      makeMessage({ job_type: "memory.embed", aggregate_id: "mem-a" }),
    );

    expect(result.commands).toHaveLength(1);
    expect(result.commands?.[0]?.job_type).toBe("memory.triage");

    const jobTypes = (result.commands ?? []).map(
      (c: PipelineCommandMessage) => c.job_type,
    );
    expect(jobTypes).not.toContain("memory.neighbors");
  });

  it("episode does NOT emit memory.synthesize when synthesize_eligible is false", async () => {
    const {
      EpisodeStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/episode-stage.service");

    const pg = new FakePg();
    // memory row — has a real embedding so the stage takes the
    // pgvector path, sees no candidates, and returns without
    // clustering. That's the "memory is fine, nothing to synthesize"
    // path the lazy contract relies on.
    pg.oneResults.push({
      id: "mem-a",
      content: "hello",
      project_id: "proj-1",
      org_id: null,
      owner_user_id: "user-1",
      embedding: `[${new Array(1024).fill(0.1).join(",")}]`,
      archived: false,
      superseded_by: null,
      updated_at: "2026-05-14T00:00:00.000Z",
    });
    // candidates query — none above the join threshold
    pg.queryResults.push([]);

    const fakeGateway = { tryGenerateObject: jest.fn() };
    const fakeResolver = { resolve: jest.fn(async () => null) };
    const fakeMemMachine = { isEnabled: () => false };
    const stage = new EpisodeStageService(
      pg,
      fakeGateway,
      fakeResolver,
      fakeMemMachine,
    );

    const result = await stage.execute(
      makeMessage({
        job_type: "memory.episode",
        aggregate_id: "mem-a",
        payload: { memory_id: "mem-a", synthesize_eligible: false },
      }),
    );

    const jobTypes = (result.commands ?? []).map(
      (c: PipelineCommandMessage) => c.job_type,
    );
    expect(jobTypes).not.toContain("memory.synthesize");
  });

  it("episode DOES emit memory.synthesize when synthesize_eligible is true (supersede path)", async () => {
    const {
      EpisodeStageService,
    } = require("../../apps/worker/src/modules/memory-engine/services/episode-stage.service");

    const pg = new FakePg();
    pg.oneResults.push({
      id: "mem-a",
      content: "hello",
      project_id: "proj-1",
      org_id: null,
      owner_user_id: "user-1",
      embedding: `[${new Array(1024).fill(0.1).join(",")}]`,
      archived: false,
      superseded_by: null,
      updated_at: "2026-05-14T00:00:00.000Z",
    });
    pg.queryResults.push([]); // no candidates → no clustering

    const fakeGateway = { tryGenerateObject: jest.fn() };
    const fakeResolver = { resolve: jest.fn(async () => null) };
    const fakeMemMachine = { isEnabled: () => false };
    const stage = new EpisodeStageService(
      pg,
      fakeGateway,
      fakeResolver,
      fakeMemMachine,
    );

    const result = await stage.execute(
      makeMessage({
        job_type: "memory.episode",
        aggregate_id: "mem-a",
        payload: { memory_id: "mem-a", synthesize_eligible: true },
      }),
    );

    const jobTypes = (result.commands ?? []).map(
      (c: PipelineCommandMessage) => c.job_type,
    );
    expect(jobTypes).toContain("memory.synthesize");
  });
});
