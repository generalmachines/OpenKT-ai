/**
 * E2E for Track C.8 observability lift —
 * `JobLedgerService.markDone` / `markFailed` mirror the canonical
 * `agentic_jobs` row onto `tool_invocations` so the dashboard's
 * observability surface can see every MQ pipeline stage run.
 *
 * What this proves:
 *   - On success, `markDone` writes a `tool_invocations` row with the
 *     `mq.<job_type>` tool name, the right org/project/user, and a
 *     duration computed from the agentic_jobs `started_at`.
 *   - On failure, `markFailed` writes a row with `status='error'` and
 *     the truncated error message.
 *   - When `org_id` is null (personal scope), the service keeps the
 *     canonical agentic_jobs row and skips the audit mirror because
 *     personal-scoped observability still needs a dedicated timeline
 *     contract.
 */

import { JobLedgerService } from "../../apps/worker/src/modules/memory-engine/services/job-ledger.service";
import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

const BASE_MESSAGE: PipelineCommandMessage = {
  message_id: "00000000-0000-0000-0000-000000000010",
  correlation_id: "00000000-0000-0000-0000-000000000010",
  causation_id: null,
  job_type: "memory.embed",
  aggregate_type: "memory",
  aggregate_id: "00000000-0000-0000-0000-0000000000aa",
  project_id: "00000000-0000-0000-0000-0000000000bb",
  org_id: "00000000-0000-0000-0000-0000000000cc",
  user_id: "00000000-0000-0000-0000-0000000000dd",
  version_token: "2026-04-29T00:00:00.000Z",
  payload: { memory_id: "00000000-0000-0000-0000-0000000000aa" },
  published_at: "2026-04-29T00:00:00.000Z",
};

interface InvocationCapture {
  sql: string;
  params: unknown[];
}

const queueConfig = {
  get: jest.fn().mockReturnValue("rabbitmq"),
};

function buildDbMock(opts: {
  startedAt: string | null;
  capture: InvocationCapture[];
}) {
  return {
    one: jest.fn().mockResolvedValue({ started_at: opts.startedAt }),
    query: jest.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      opts.capture.push({ sql, params });
      return [];
    }),
  };
}

describe("JobLedgerService — observability ledger (Track C.8)", () => {
  it("writes a tool_invocations row on markDone", async () => {
    const startedAt = "2026-04-29T00:00:01.000Z";
    const capture: InvocationCapture[] = [];
    const db = buildDbMock({ startedAt, capture });
    const service = new JobLedgerService(db as never, queueConfig as never);

    const before = Date.now();
    await service.markDone(
      "agentic-job-1",
      { embedded: true },
      BASE_MESSAGE,
    );
    const after = Date.now();

    expect(capture).toHaveLength(1);
    const inserted = decodeInvocationParams(capture[0]!.params);

    expect(inserted).toMatchObject({
      org_id: BASE_MESSAGE.org_id,
      project_id: BASE_MESSAGE.project_id,
      user_id: BASE_MESSAGE.user_id,
      tool_name: "mq.memory.embed",
      status: "ok",
      result_summary: { embedded: true },
      agent_identity: "worker",
      session_id: null,
    });
    expect(inserted.error_message).toBeNull();

    // Duration is completed_at - started_at; both happen during the test
    // window, so the value is at least 0 and bounded by elapsed wall time.
    expect(typeof inserted.duration_ms).toBe("number");
    expect(inserted.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(inserted.duration_ms as number).toBeLessThanOrEqual(
      after - before + Date.parse("2026-04-29T00:00:00.000Z") + 5_000,
    );

    const args = inserted.args as Record<string, unknown>;
    expect(args).toMatchObject({
      correlation_id: BASE_MESSAGE.correlation_id,
      aggregate_type: "memory",
      aggregate_id: BASE_MESSAGE.aggregate_id,
      memory_id: BASE_MESSAGE.aggregate_id,
      version_token: BASE_MESSAGE.version_token,
    });
  });

  it("writes a tool_invocations row on markFailed with truncated error", async () => {
    const capture: InvocationCapture[] = [];
    const db = buildDbMock({
      startedAt: "2026-04-29T00:00:01.000Z",
      capture,
    });
    const service = new JobLedgerService(db as never, queueConfig as never);

    const longError = "x".repeat(2_000);
    await service.markFailed("agentic-job-2", longError, BASE_MESSAGE);

    expect(capture).toHaveLength(1);
    const inserted = decodeInvocationParams(capture[0]!.params);
    expect(inserted.status).toBe("error");
    expect(inserted.tool_name).toBe("mq.memory.embed");
    // truncated to 1000 chars by the existing truncateError helper
    expect((inserted.error_message as string).length).toBeLessThanOrEqual(1000);
    expect((inserted.error_message as string).startsWith("xxx")).toBe(true);
  });

  it("skips tool_invocations when message has org_id=null (personal scope)", async () => {
    const capture: InvocationCapture[] = [];
    const db = buildDbMock({
      startedAt: "2026-04-29T00:00:01.000Z",
      capture,
    });
    const service = new JobLedgerService(db as never, queueConfig as never);

    const personalMessage: PipelineCommandMessage = {
      ...BASE_MESSAGE,
      org_id: null,
    };

    await service.markDone(
      "agentic-job-3",
      { embedded: true },
      personalMessage,
    );

    // agentic_jobs update happened…
    expect(db.one).toHaveBeenCalledTimes(1);
    // …but no tool_invocations insert for personal scope.
    expect(capture).toHaveLength(0);
  });

  it("does not write an invocation row when no message is passed (legacy callsite)", async () => {
    const capture: InvocationCapture[] = [];
    const db = buildDbMock({
      startedAt: "2026-04-29T00:00:01.000Z",
      capture,
    });
    const service = new JobLedgerService(db as never, queueConfig as never);

    await service.markDone("agentic-job-4", { ok: true });

    expect(db.one).toHaveBeenCalledTimes(1);
    expect(capture).toHaveLength(0);
  });
});

function decodeInvocationParams(params: unknown[]): Record<string, unknown> {
  return {
    org_id: params[0],
    project_id: params[1],
    user_id: params[2],
    tool_name: params[3],
    args: JSON.parse(params[4] as string) as Record<string, unknown>,
    result_summary: JSON.parse(params[5] as string) as Record<string, unknown>,
    status: params[6],
    error_message: params[7],
    duration_ms: params[8],
    session_id: null,
    agent_identity: "worker",
    invoked_at: params[9],
  };
}
