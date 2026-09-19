// Unit tests for PipelineStreamService.
//
// We avoid spinning up Nest — the service uses Drizzle's
// db.execute(sql`…`) which is straightforward to stub directly. The
// SQL itself is opaque to the test (we don't run pg); what we verify
// is:
//
//   1. The cursor encoding round-trips correctly and the service
//      passes the decoded (timestamp, kind, id) tuple into the SQL
//      via bound params (visible in the captured Drizzle SqlQuery's
//      string form).
//   2. The response shape: events array (one per row, kind-specific
//      payload), the cursor presence rule (set iff we overflowed the
//      limit), and the stats counter.
//   3. Truncation behaviour for huge response_text / prompt_messages.
//   4. Project-access enforcement via the @openkt/auth-authorization
//      mock — requireProjectAccess must fire before SQL.

jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireProjectAccess: jest.fn().mockResolvedValue({
      projectId: "11111111-1111-1111-1111-111111111111",
      orgId: null,
      ownerUserId: "22222222-2222-2222-2222-222222222222",
      visibility: "project",
      role: "owner",
    }),
  };
});

import { requireProjectAccess } from "@openkt/auth-authorization";

import { PipelineStreamService } from "../../apps/server/src/modules/observability/services/pipeline-stream.service";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

function fakeContext() {
  return {
    principal: { userId: "22222222-2222-2222-2222-222222222222" },
  } as never;
}

function makeStageRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "stage",
    id: "job-1",
    ts: "2026-05-14T10:00:01.000Z",
    stage_kind: "triage",
    stage_name: "triage",
    status: "done",
    started_at: "2026-05-14T10:00:00.000Z",
    completed_at: "2026-05-14T10:00:01.000Z",
    payload: { memory_id: "m-1" },
    result: { tags: ["postgres"] },
    error: null,
    provider: null,
    model: null,
    llm_stage: null,
    prompt_messages: null,
    response_text: null,
    response_metadata: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    cost_usd: null,
    latency_ms: null,
    llm_status: null,
    error_reason: null,
    memory_id: "m-1",
    episode_id: null,
    event_type: null,
    aggregate_id: null,
    aggregate_type: null,
    attempts: null,
    last_error: null,
    claimed_at: null,
    published_at: null,
    ...over,
  };
}

function makeLlmRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    ...makeStageRow(),
    kind: "llm_call",
    id: "lc-1",
    ts: "2026-05-14T10:00:00.500Z",
    stage_kind: null,
    stage_name: null,
    status: null,
    started_at: null,
    completed_at: null,
    payload: null,
    result: null,
    provider: "minimax",
    model: "MiniMax-M2.7",
    llm_stage: "triage",
    prompt_messages: [{ role: "user", content: "hello" }],
    response_text: "world",
    response_metadata: { id: "chat-1" },
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    cost_usd: "0.0001",
    latency_ms: 420,
    llm_status: "success",
    ...over,
  };
}

function makeOutboxRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    ...makeStageRow(),
    kind: "outbox",
    id: "ob-1",
    ts: "2026-05-14T10:00:00.000Z",
    stage_kind: null,
    stage_name: null,
    status: null,
    started_at: null,
    completed_at: null,
    payload: null,
    result: null,
    event_type: "memory.created",
    aggregate_id: "m-1",
    aggregate_type: "memory",
    attempts: 1,
    last_error: null,
    claimed_at: "2026-05-14T10:00:00.000Z",
    published_at: "2026-05-14T10:00:00.000Z",
    ...over,
  };
}

describe("PipelineStreamService.stream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("UNIONs the three sources, normalises rows, and returns kind-specific event shapes", async () => {
    const fakeDb = {
      execute: jest.fn(async () => ({
        rows: [makeStageRow(), makeLlmRow(), makeOutboxRow()],
      })),
    };

    const service = new PipelineStreamService(fakeDb as never);
    const result = await service.stream(fakeContext(), {
      project_id: PROJECT_ID,
      limit: 100,
    });

    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      "read",
    );

    expect(result.events).toHaveLength(3);

    const stage = result.events[0];
    expect(stage.kind).toBe("stage");
    expect(stage.event).toMatchObject({
      id: "job-1",
      stage: "triage",
      status: "done",
      memory_id: "m-1",
      result: { tags: ["postgres"] },
    });

    const llm = result.events[1];
    expect(llm.kind).toBe("llm_call");
    expect(llm.event).toMatchObject({
      id: "lc-1",
      provider: "minimax",
      model: "MiniMax-M2.7",
      stage: "triage",
      prompt_tokens: 12,
      completion_tokens: 4,
      latency_ms: 420,
      status: "success",
      response_text: "world",
    });

    const outbox = result.events[2];
    expect(outbox.kind).toBe("outbox");
    expect(outbox.event).toMatchObject({
      id: "ob-1",
      event_type: "memory.created",
      aggregate_id: "m-1",
      aggregate_type: "memory",
      attempts: 1,
    });

    expect(result.stats).toEqual({ stages: 1, llm_calls: 1, outbox: 1 });
    // No overflow (3 rows ≤ limit 100) → cursor is null.
    expect(result.cursor).toBeNull();
  });

  it("returns a base64url cursor when the result hits limit+1 and slices to limit", async () => {
    const rows = Array.from({ length: 6 }, (_, idx) =>
      makeStageRow({
        id: `job-${idx}`,
        // Each row is one second earlier than the previous so the
        // ORDER BY ts DESC stays deterministic.
        ts: `2026-05-14T10:00:0${5 - idx}.000Z`,
      }),
    );
    const fakeDb = {
      execute: jest.fn(async () => ({ rows })),
    };

    const service = new PipelineStreamService(fakeDb as never);
    const result = await service.stream(fakeContext(), {
      project_id: PROJECT_ID,
      limit: 5,
    });

    expect(result.events).toHaveLength(5);
    expect(result.cursor).toBeTruthy();
    // base64url decodes to "<timestamp>|<kind>|<id>" — verify we can
    // round-trip the cursor and recover the last event's coordinates.
    const decoded = Buffer.from(result.cursor as string, "base64url").toString(
      "utf8",
    );
    const [ts, kind, id] = decoded.split("|");
    expect(kind).toBe("stage");
    expect(id).toBe("job-4");
    expect(ts).toBe("2026-05-14T10:00:01.000Z");
  });

  it("uses the cursor's timestamp + kind + id tuple in the SQL bound params", async () => {
    const fakeDb = {
      execute: jest.fn(async () => ({ rows: [] })),
    };

    const cursor = Buffer.from(
      "2026-05-14T10:00:00.000Z|stage|job-x",
      "utf8",
    ).toString("base64url");

    const service = new PipelineStreamService(fakeDb as never);
    await service.stream(fakeContext(), {
      project_id: PROJECT_ID,
      limit: 50,
      cursor,
    });

    // Drizzle's SqlQuery captures bound parameters on .queryChunks.
    // The simplest reliable assertion is that the produced query
    // object stringifies with the cursor values somewhere in its
    // bound-parameter list — we read the chunks array directly.
    expect(fakeDb.execute).toHaveBeenCalledTimes(1);
    const calls = fakeDb.execute.mock.calls as unknown as unknown[][];
    const firstCall = calls[0]?.[0];
    const queryChunks =
      firstCall && typeof firstCall === "object" && firstCall !== null
        ? ((firstCall as { queryChunks?: unknown[] }).queryChunks ?? [])
        : [];
    const flat = JSON.stringify(queryChunks);
    expect(flat).toContain("2026-05-14T10:00:00.000Z");
    expect(flat).toContain("job-x");
  });

  it("truncates a huge response_text and serialised prompt_messages", async () => {
    const big = "z".repeat(20_000);
    const bigPrompt = Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      content: `chunk ${i} ` + "y".repeat(200),
    }));
    const fakeDb = {
      execute: jest.fn(async () => ({
        rows: [
          makeLlmRow({
            id: "lc-big",
            response_text: big,
            prompt_messages: bigPrompt,
          }),
        ],
      })),
    };

    const service = new PipelineStreamService(fakeDb as never);
    const result = await service.stream(fakeContext(), {
      project_id: PROJECT_ID,
      limit: 100,
    });

    const ev = result.events[0].event as {
      response_text: string;
      prompt_messages: unknown;
    };
    expect(typeof ev.response_text).toBe("string");
    expect(ev.response_text.length).toBeLessThan(big.length);
    expect(ev.response_text.endsWith("[truncated]")).toBe(true);
    // Huge prompt should be replaced with a {_truncated, preview} marker.
    expect(ev.prompt_messages).toEqual(
      expect.objectContaining({ _truncated: true, preview: expect.any(String) }),
    );
  });

  it("returns an empty payload when no events match (cursor null, stats zeros)", async () => {
    const fakeDb = {
      execute: jest.fn(async () => ({ rows: [] })),
    };
    const service = new PipelineStreamService(fakeDb as never);
    const result = await service.stream(fakeContext(), {
      project_id: PROJECT_ID,
      limit: 100,
    });
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.stats).toEqual({ stages: 0, llm_calls: 0, outbox: 0 });
  });
});
