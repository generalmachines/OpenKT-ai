// Pins the triage synthesize gate. Two fire paths:
//   1. The triage LLM flagged a supersede (resolvedSupersedesId is set).
//   2. The memory's kind is a high-signal kind (decision, pattern,
//      incident, anti-pattern, skill — see DEFAULT_SYNTHESIZE_KINDS).
//
// Production regression we're guarding against: until 2026-05-15 the
// gate was `synthesize_eligible: resolvedSupersedesId !== null`, so the
// synthesize stage never fired in prod (the triage LLM is conservative
// and returns `supersedes: null` for nearly every memory). The widening
// adds the high-signal-kind path.

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
    job_type: "memory.triage",
    aggregate_type: "memory",
    aggregate_id: "00000000-0000-0000-0000-000000000aaa",
    project_id: "00000000-0000-0000-0000-000000000bbb",
    org_id: null,
    user_id: "00000000-0000-0000-0000-000000000ccc",
    version_token: "2026-05-15T00:00:00.000Z",
    payload: {},
    published_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function memoryRow(kind: string): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000aaa",
    content: "hello",
    kind,
    project_id: "proj-1",
    org_id: null,
    owner_user_id: "user-1",
    embedding: `[${new Array(1024).fill(0.1).join(",")}]`,
    archived: false,
    superseded_by: null,
    updated_at: "2026-05-15T00:00:00.000Z",
  };
}

function buildStage(pg: FakePg, llmObject: { tags: string[]; duplicate_of: string | null; supersedes: string | null }) {
  const {
    TriageStageService,
  } = require("../../apps/worker/src/modules/memory-engine/services/triage-stage.service");

  const gateway = {
    tryGenerateObject: jest.fn(async () => ({
      object: llmObject,
      provider: "test",
      model: "test",
    })),
  };
  const resolver = { resolve: jest.fn(async () => null) };
  const tagMatcher = {
    match: jest.fn(async () => ({ tagIds: [], resolutions: [] })),
  };
  const config = { get: jest.fn(() => undefined) };
  return new TriageStageService(pg, gateway, tagMatcher, resolver, config);
}

describe("Triage synthesize gate", () => {
  it("sets synthesize_eligible=true for a decision-kind memory even when supersedes is null", async () => {
    const pg = new FakePg();
    pg.oneResults.push(memoryRow("decision"));
    pg.queryResults.push([]); // no neighbor candidates → empty candidateRows lookup

    const stage = buildStage(pg, {
      tags: [],
      duplicate_of: null,
      supersedes: null,
    });

    const result = await stage.execute(makeMessage());

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].job_type).toBe("memory.episode");
    expect(result.commands[0].payload.synthesize_eligible).toBe(true);
  });

  it("sets synthesize_eligible=false for a context-kind memory when supersedes is null", async () => {
    const pg = new FakePg();
    pg.oneResults.push(memoryRow("context"));
    pg.queryResults.push([]);

    const stage = buildStage(pg, {
      tags: [],
      duplicate_of: null,
      supersedes: null,
    });

    const result = await stage.execute(makeMessage());

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].job_type).toBe("memory.episode");
    expect(result.commands[0].payload.synthesize_eligible).toBe(false);
  });

  it("sets synthesize_eligible=true for any kind when supersedes resolves to a live candidate", async () => {
    const pg = new FakePg();
    pg.oneResults.push(memoryRow("note"));
    // candidate row for the supersede target
    pg.queryResults.push([
      { id: "00000000-0000-0000-0000-000000000fff", similarity: 0.9 },
    ]);
    pg.queryResults.push([
      {
        id: "00000000-0000-0000-0000-000000000fff",
        content: "old",
        kind: "note",
        archived: false,
        superseded_by: null,
      },
    ]);

    const stage = buildStage(pg, {
      tags: [],
      duplicate_of: null,
      supersedes: "00000000-0000-0000-0000-000000000fff",
    });

    const result = await stage.execute(makeMessage());

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].payload.synthesize_eligible).toBe(true);
  });
});
