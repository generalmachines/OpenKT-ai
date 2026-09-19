import { PreprocessStageService } from "../../apps/worker/src/modules/memory-engine/services/preprocess-stage.service";
import { EmbedStageService } from "../../apps/worker/src/modules/memory-engine/services/embed-stage.service";
import { MemoryPipelineOrchestratorService } from "../../apps/worker/src/modules/memory-engine/services/memory-pipeline.orchestrator.service";
import { JobLedgerService } from "../../apps/worker/src/modules/memory-engine/services/job-ledger.service";
import {
  MEMORY_COMMANDS_EXCHANGE,
  MEMORY_EVENTS_EXCHANGE,
  ROUTING_KEY_EMBED_DONE,
  ROUTING_KEY_STAGE_FAILED,
} from "../../apps/worker/src/modules/mq/mq.constants";
import type { PipelineCommandMessage } from "../../apps/worker/src/modules/memory-engine/pipeline-message";

const MESSAGE: PipelineCommandMessage = {
  message_id: "00000000-0000-0000-0000-000000000001",
  correlation_id: "00000000-0000-0000-0000-000000000001",
  causation_id: null,
  job_type: "memory.preprocess",
  aggregate_type: "memory",
  aggregate_id: "00000000-0000-0000-0000-0000000000ab",
  project_id: "00000000-0000-0000-0000-0000000000cd",
  org_id: "00000000-0000-0000-0000-0000000000ef",
  user_id: "00000000-0000-0000-0000-0000000000aa",
  version_token: "2026-04-29T00:00:00.000Z",
  payload: {
    memory_id: "00000000-0000-0000-0000-0000000000ab",
    project_id: "00000000-0000-0000-0000-0000000000cd",
    org_id: "00000000-0000-0000-0000-0000000000ef",
    owner_user_id: "00000000-0000-0000-0000-0000000000aa",
  },
  published_at: "2026-04-29T00:00:00.000Z",
};

describe("Memory engine pipeline (e2e)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("fans out only the embed command from preprocess (briefing+member_knowledge are now cron-batched)", async () => {
    const db = {
      one: jest.fn().mockResolvedValue({
        id: MESSAGE.aggregate_id,
        project_id: MESSAGE.project_id,
        org_id: MESSAGE.org_id,
        owner_user_id: MESSAGE.user_id,
        archived: false,
        updated_at: MESSAGE.version_token,
      }),
    };
    const service = new PreprocessStageService(db as never);

    const result = await service.execute(MESSAGE);

    expect(result.eventRoutingKey).toBe("memory.preprocess.done");
    expect(result.commands).toHaveLength(1);
    expect(result.commands?.map((command) => command.job_type)).toEqual([
      "memory.embed",
    ]);
    expect(result.commands?.[0]).toMatchObject({
      aggregate_id: MESSAGE.aggregate_id,
      project_id: MESSAGE.project_id,
      job_type: "memory.embed",
    });
  });

  it("writes an embedding and advances to triage", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [new Array(1024).fill(0.25)],
    } as Response);

    const db = {
      one: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.trim().startsWith("select")) {
          return {
            id: MESSAGE.aggregate_id,
            content: "Memory content",
            project_id: MESSAGE.project_id,
            org_id: MESSAGE.org_id,
            owner_user_id: MESSAGE.user_id,
            embedding: null,
            archived: false,
            updated_at: MESSAGE.version_token,
          };
        }
        return { updated_at: "2026-04-29T00:00:05.000Z" };
      }),
    };
    // EmbedStageService takes just the worker pg service.
    const service = new EmbedStageService(db as never);

    const result = await service.execute({
      ...MESSAGE,
      job_type: "memory.embed",
      payload: {
        memory_id: MESSAGE.aggregate_id,
        project_id: MESSAGE.project_id,
        org_id: MESSAGE.org_id,
        owner_user_id: MESSAGE.user_id,
      },
    });

    expect(db.one).toHaveBeenCalledWith(
      expect.stringContaining("update memories"),
      [MESSAGE.aggregate_id, expect.stringContaining("[")],
    );
    expect(result.eventRoutingKey).toBe(ROUTING_KEY_EMBED_DONE);
    // embed-stage now only fans out memory.triage — the neighbors
    // job was reverted to lazy recall-time computation cached in
    // `memory_neighbors` for 24h.
    expect(result.commands).toHaveLength(1);
    const jobTypes = (result.commands ?? []).map((c) => c.job_type).sort();
    expect(jobTypes).toEqual(["memory.triage"]);
    for (const cmd of result.commands ?? []) {
      expect(cmd.version_token).toBe("2026-04-29T00:00:05.000Z");
    }
  });

  it("marks failed stages and emits stage.failed events", async () => {
    const begin = jest.fn().mockResolvedValue({
      jobId: "job-1",
      stage: "embed",
      shouldRun: true,
    });
    const markDone = jest.fn();
    const markFailed = jest.fn().mockResolvedValue(undefined);
    const publisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new MemoryPipelineOrchestratorService(
      { begin, markDone, markFailed } as never,
      { execute: jest.fn() } as never, // preprocess
      { execute: jest.fn().mockRejectedValue(new Error("embedding down")) } as never, // embed
      { execute: jest.fn() } as never, // triage
      { execute: jest.fn() } as never, // episode
      // synthesize stage (added by knowledge-synthesis layer)
      { execute: jest.fn() } as never, // synthesize
      { execute: jest.fn() } as never, // member_knowledge
      { execute: jest.fn() } as never, // briefing
      publisher as never,
    );

    await expect(
      orchestrator.handle({
        ...MESSAGE,
        job_type: "memory.embed",
      }),
    ).rejects.toThrow("embedding down");

    expect(markDone).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "job-1",
      "embedding down",
      expect.objectContaining({ job_type: "memory.embed" }),
    );
    expect(publisher.publish).toHaveBeenCalledWith(
      MEMORY_EVENTS_EXCHANGE,
      ROUTING_KEY_STAGE_FAILED,
      expect.objectContaining({
        aggregate_id: MESSAGE.aggregate_id,
        payload: expect.objectContaining({
          stage_result: expect.objectContaining({
            failed: true,
            error: "embedding down",
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(publisher.publish).not.toHaveBeenCalledWith(
      MEMORY_COMMANDS_EXCHANGE,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("distinguishes a fresh running duplicate from an already-done job", async () => {
    const publisher = { publish: jest.fn() };
    const buildOrchestrator = (skipReason: "in_progress" | "done") =>
      new MemoryPipelineOrchestratorService(
        {
          begin: jest.fn().mockResolvedValue({
            jobId: "job-1",
            stage: "preprocess",
            shouldRun: false,
            skipReason,
          }),
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        publisher as never,
      );

    await expect(buildOrchestrator("in_progress").handle(MESSAGE)).resolves.toBe(
      "in_progress",
    );
    await expect(buildOrchestrator("done").handle(MESSAGE)).resolves.toBe(
      "already_done",
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("labels fresh-running and done ledger duplicates distinctly", async () => {
    const db = {
      one: jest
        .fn()
        .mockResolvedValueOnce({
          id: "job-running",
          status: "running",
          attempts: 1,
          max_attempts: 5,
          started_at: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          id: "job-done",
          status: "done",
          attempts: 1,
          max_attempts: 5,
          started_at: new Date().toISOString(),
        }),
    };
    const ledger = new JobLedgerService(
      db as never,
      { get: jest.fn().mockReturnValue("rabbitmq") } as never,
    );

    await expect(ledger.begin(MESSAGE)).resolves.toEqual(
      expect.objectContaining({
        jobId: "job-running",
        shouldRun: false,
        skipReason: "in_progress",
      }),
    );
    await expect(ledger.begin(MESSAGE)).resolves.toEqual(
      expect.objectContaining({
        jobId: "job-done",
        shouldRun: false,
        skipReason: "done",
      }),
    );
  });

  it("records new ledger jobs with the selected SQS source", async () => {
    const db = {
      one: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "job-sqs" }),
    };
    const ledger = new JobLedgerService(
      db as never,
      { get: jest.fn().mockReturnValue("sqs") } as never,
    );

    await expect(ledger.begin(MESSAGE)).resolves.toEqual(
      expect.objectContaining({
        jobId: "job-sqs",
        shouldRun: true,
      }),
    );

    const [sql, params] = db.one.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("$12");
    expect(params[11]).toBe("sqs");
  });

  it("updates retried ledger jobs to the selected SQS source", async () => {
    const db = {
      one: jest
        .fn()
        .mockResolvedValueOnce({
          id: "job-retry",
          status: "failed",
          attempts: 1,
          max_attempts: 5,
          started_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .mockResolvedValueOnce({ id: "job-retry" }),
    };
    const ledger = new JobLedgerService(
      db as never,
      { get: jest.fn().mockReturnValue("sqs") } as never,
    );

    await expect(ledger.begin(MESSAGE)).resolves.toEqual(
      expect.objectContaining({
        jobId: "job-retry",
        shouldRun: true,
      }),
    );

    const [sql, params] = db.one.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("source = $13");
    expect(params[12]).toBe("sqs");
  });
});
