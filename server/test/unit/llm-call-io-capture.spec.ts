// Unit tests for the LLM I/O capture path added in migration 0025.
//
// Covers two pieces:
//   1. The `truncatePromptMessages` helper used by both recorders —
//      verifies each prompt message's content is capped at 8KB and
//      that the returned `truncated` flag flips when at least one
//      message hit the cap.
//   2. The worker recorder's insert SQL — verifies the new columns
//      (prompt_messages, response_text, response_metadata, truncated)
//      are included in the parameter vector in the right positions.

import {
  truncatePromptMessages,
  truncateString,
  WorkerLlmCallRecorder,
} from "../../apps/worker/src/modules/memory-engine/services/worker-llm-call-recorder.service";

interface PgCall {
  sql: string;
  params: unknown[];
}

class FakePg {
  public calls: PgCall[] = [];
  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, params });
    return null;
  }
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, params });
    return [];
  }
}

describe("truncatePromptMessages", () => {
  it("returns {messages:null, truncated:false} when no messages are passed", () => {
    expect(truncatePromptMessages(undefined)).toEqual({
      messages: null,
      truncated: false,
    });
    expect(truncatePromptMessages([])).toEqual({
      messages: null,
      truncated: false,
    });
  });

  it("passes short messages through unchanged with truncated=false", () => {
    const input = [
      { role: "system" as const, content: "hi" },
      { role: "user" as const, content: "world" },
    ];
    const result = truncatePromptMessages(input);
    expect(result.truncated).toBe(false);
    expect(result.messages).toEqual(input);
  });

  it("truncates a single message to 8KB and sets truncated=true", () => {
    const huge = "x".repeat(10_000); // 10KB > 8KB cap
    const result = truncatePromptMessages([
      { role: "user", content: huge },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.messages).not.toBeNull();
    const content = result.messages![0].content;
    // Truncated content = 8KB + "…[truncated]" suffix
    expect(content.length).toBeLessThan(huge.length);
    expect(content.startsWith("x".repeat(8 * 1024))).toBe(true);
    expect(content.endsWith("[truncated]")).toBe(true);
  });

  it("truncated=true even when only one of N messages was oversize", () => {
    const result = truncatePromptMessages([
      { role: "system", content: "short prompt" },
      { role: "user", content: "y".repeat(9_000) },
      { role: "assistant", content: "ok" },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.messages![0].content).toBe("short prompt");
    expect(result.messages![1].content.length).toBeLessThan(9_000);
    expect(result.messages![2].content).toBe("ok");
  });
});

describe("truncateString", () => {
  it("returns null for null/undefined", () => {
    expect(truncateString(null, 100)).toBeNull();
  });
  it("returns the value unchanged when shorter than the cap", () => {
    expect(truncateString("hello", 100)).toBe("hello");
  });
  it("appends a truncation marker when over the cap", () => {
    const out = truncateString("z".repeat(200), 50);
    expect(out!.length).toBeGreaterThan(50);
    expect(out!.startsWith("z".repeat(50))).toBe(true);
    expect(out!.endsWith("[truncated]")).toBe(true);
  });
});

describe("WorkerLlmCallRecorder.insert — migration 0025 columns", () => {
  it("includes prompt_messages, response_text, response_metadata, and truncated in the insert params", async () => {
    const pg = new FakePg();
    const recorder = new WorkerLlmCallRecorder(pg as never);
    await recorder.insert(
      {
        provider: "minimax",
        model: "MiniMax-M2.7",
        promptTokens: 100,
        completionTokens: 20,
        latencyMs: 412,
        status: "success",
        costUsd: 0.0012,
        promptMessages: [
          { role: "system", content: "you are a triage agent" },
          { role: "user", content: "memory content here" },
        ],
        responseText: '{"tags":["postgres"]}',
        responseMetadata: { finish_reason: "stop", id: "chat-abc" },
      },
      { stage: "triage", projectId: null, userId: null },
    );
    expect(pg.calls).toHaveLength(1);
    const call = pg.calls[0];
    expect(call.sql).toContain("prompt_messages");
    expect(call.sql).toContain("response_text");
    expect(call.sql).toContain("response_metadata");
    expect(call.sql).toContain("truncated");
    // The four new columns are appended at the end of the param vector
    // (positions 15..18, after request_id at position 14).
    expect(call.params[14]).toBeNull(); // request_id
    expect(typeof call.params[15]).toBe("string"); // prompt_messages JSON
    expect(call.params[15]).toContain("triage agent");
    expect(call.params[16]).toBe('{"tags":["postgres"]}'); // response_text
    expect(typeof call.params[17]).toBe("string"); // response_metadata JSON
    expect(call.params[17]).toContain("finish_reason");
    expect(call.params[18]).toBe(false); // truncated
  });

  it("sets truncated=true when a prompt message exceeded the 8KB cap", async () => {
    const pg = new FakePg();
    const recorder = new WorkerLlmCallRecorder(pg as never);
    await recorder.insert(
      {
        provider: "openai",
        model: "gpt-4o-mini",
        promptTokens: 100,
        completionTokens: 20,
        latencyMs: 1200,
        status: "success",
        costUsd: 0.001,
        promptMessages: [
          { role: "user", content: "z".repeat(20_000) },
        ],
        responseText: "ok",
        responseMetadata: null,
      },
      { stage: "synthesize" },
    );
    const call = pg.calls[0];
    expect(call.params[18]).toBe(true);
    // The stored prompt_messages JSON contains the truncated marker.
    const messagesJson = call.params[15] as string;
    expect(messagesJson).toContain("[truncated]");
  });

  it("writes NULLs for the new I/O columns when OPENKT_LLM_IO_CAPTURE=false", async () => {
    const PREV = process.env.OPENKT_LLM_IO_CAPTURE;
    process.env.OPENKT_LLM_IO_CAPTURE = "false";
    try {
      const pg = new FakePg();
      const recorder = new WorkerLlmCallRecorder(pg as never);
      await recorder.insert(
        {
          provider: "minimax",
          model: "MiniMax-M2.7",
          promptTokens: 100,
          completionTokens: 20,
          latencyMs: 412,
          status: "success",
          costUsd: 0.001,
          promptMessages: [
            { role: "system", content: "should not be captured" },
          ],
          responseText: "should not be captured either",
          responseMetadata: { finish_reason: "stop" },
        },
        { stage: "triage" },
      );
      const call = pg.calls[0];
      expect(call.params[15]).toBeNull();
      expect(call.params[16]).toBeNull();
      expect(call.params[17]).toBeNull();
      expect(call.params[18]).toBe(false);
    } finally {
      if (PREV === undefined) {
        delete process.env.OPENKT_LLM_IO_CAPTURE;
      } else {
        process.env.OPENKT_LLM_IO_CAPTURE = PREV;
      }
    }
  });
});
