// Unit tests for CaptureService — the /v1/capture Stage-2 LLM
// classify+extract path. No Nest, no DB: LlmGatewayService and
// MemoryCommandsApplicationService are stubbed.
//
// Regression anchor (2026-06-05): CaptureService used to hand-build
// CreateMemoryInput with an `as` cast, skipping the zod parse that
// the REST and MCP save paths run. The contract default
// visibility:"project" was therefore never applied, and the live
// memories.visibility column is NOT NULL with no DB default —
// every saveable capture 500'd at insert. The service must build
// its input via CreateMemorySchema so the defaults land.

import type { ActorContext } from "@openkt/core-context";

import { CaptureService } from "../../apps/server/src/modules/capture/services/capture.service";
import type { LlmGatewayService } from "@openkt/platform-llm";
import type { MemoryCommandsApplicationService } from "../../apps/server/src/modules/memory/services/memory-commands.application.service";

const actor = { principal: { userId: "11111111-1111-4111-8111-111111111111" } } as ActorContext;

function llmReturning(text: string): LlmGatewayService {
  return {
    generate: jest.fn().mockResolvedValue({ text }),
  } as unknown as LlmGatewayService;
}

function memoryCommandsReturning(result: unknown): MemoryCommandsApplicationService {
  return {
    create: jest.fn().mockResolvedValue(result),
  } as unknown as MemoryCommandsApplicationService;
}

const SAVEABLE_VERDICT = JSON.stringify({
  saveable: true,
  kind: "environment",
  content: "The staging RDS runs on port 5433, not 5432.",
  confidence: 0.9,
  reason: "Concrete infra fact",
});

describe("CaptureService.capture", () => {
  it("passes a fully-defaulted CreateMemoryInput to memoryCommands.create (visibility!)", async () => {
    const memoryCommands = memoryCommandsReturning({ id: "mem-1" });
    const service = new CaptureService(llmReturning(SAVEABLE_VERDICT), memoryCommands);

    const result = await service.capture(actor, {
      prompt: "remember: the staging RDS runs on port 5433 not 5432",
      project_id: "openkt-server",
    });

    expect(result.saved).toBe(true);
    expect(result.memory_id).toBe("mem-1");

    const createInput = (memoryCommands.create as jest.Mock).mock.calls[0][1];
    // The contract defaults MUST be materialized — visibility above all:
    // memories.visibility is NOT NULL with no DB default, so leaving it
    // undefined turns into a Postgres not-null violation (500).
    expect(createInput.visibility).toBe("project");
    expect(createInput.category).toBeNull();
    expect(createInput.source_refs).toEqual([]);
    expect(createInput.content).toBe("The staging RDS runs on port 5433, not 5432.");
    expect(createInput.kind).toBe("environment");
    expect(createInput.confidence).toBe(0.9);
    expect(createInput.importance).toBe(0.4);
    expect(createInput.tag_slugs).toEqual(["captured-from-prompt"]);
    expect(createInput.project_id).toBe("openkt-server");
  });

  it("returns saved:false (not a throw) when the LLM hallucinates a kind outside the contract", async () => {
    const memoryCommands = memoryCommandsReturning({ id: "mem-x" });
    const service = new CaptureService(
      llmReturning(
        JSON.stringify({
          saveable: true,
          kind: "vibes", // not in MemoryKindSchema
          content: "Something plausible.",
          confidence: 0.9,
          reason: "test",
        }),
      ),
      memoryCommands,
    );

    const result = await service.capture(actor, {
      prompt: "a prompt long enough to pass the controller gate",
      project_id: "p",
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toContain("failed validation");
    expect(memoryCommands.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns saved:false when the LLM verdict is not saveable", async () => {
    const memoryCommands = memoryCommandsReturning({ id: "nope" });
    const service = new CaptureService(
      llmReturning(JSON.stringify({ saveable: false, confidence: 1, reason: "smalltalk" })),
      memoryCommands,
    );

    const result = await service.capture(actor, {
      prompt: "how is the weather today my friend",
      project_id: "p",
    });

    expect(result).toEqual({ saved: false, reason: "smalltalk" });
    expect(memoryCommands.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns saved:false below the 0.6 confidence floor", async () => {
    const memoryCommands = memoryCommandsReturning({ id: "nope" });
    const service = new CaptureService(
      llmReturning(
        JSON.stringify({
          saveable: true,
          kind: "context",
          content: "Weak signal.",
          confidence: 0.4,
          reason: "meh",
        }),
      ),
      memoryCommands,
    );

    const result = await service.capture(actor, { prompt: "weak signal prompt", project_id: "p" });

    expect(result.saved).toBe(false);
    expect(result.reason).toContain("< 0.6 floor");
    expect(memoryCommands.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("strips ```json fences before parsing the verdict", async () => {
    const memoryCommands = memoryCommandsReturning({ id: "mem-2" });
    const service = new CaptureService(
      llmReturning("```json\n" + SAVEABLE_VERDICT + "\n```"),
      memoryCommands,
    );

    const result = await service.capture(actor, {
      prompt: "remember: the staging RDS runs on port 5433 not 5432",
      project_id: "p",
    });

    expect(result.saved).toBe(true);
    expect(result.memory_id).toBe("mem-2");
  });

  it("returns saved:false when the LLM returns non-JSON", async () => {
    const service = new CaptureService(
      llmReturning("Sure! Here's my analysis: it looks saveable to me."),
      memoryCommandsReturning({ id: "x" }),
    );

    const result = await service.capture(actor, { prompt: "whatever prompt", project_id: "p" });

    expect(result).toEqual({ saved: false, reason: "LLM output not JSON" });
  });

  it("returns saved:false when the LLM gateway throws", async () => {
    const llm = {
      generate: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    } as unknown as LlmGatewayService;
    const service = new CaptureService(llm, memoryCommandsReturning({ id: "x" }));

    const result = await service.capture(actor, { prompt: "whatever prompt", project_id: "p" });

    expect(result).toEqual({ saved: false, reason: "LLM unavailable; capture skipped" });
  });

  it("surfaces a memory-gate suggestion as saved:false", async () => {
    const memoryCommands = memoryCommandsReturning({
      verdict: "reject-too-long",
      reason: "content too long",
      suggested_skill: { slug_suggestion: "s", title_suggestion: "S", preview: "p" },
    });
    const service = new CaptureService(llmReturning(SAVEABLE_VERDICT), memoryCommands);

    const result = await service.capture(actor, {
      prompt: "remember: the staging RDS runs on port 5433 not 5432",
      project_id: "p",
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toContain("reject-too-long");
  });
});
