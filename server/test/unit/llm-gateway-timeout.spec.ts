// Tests for the per-attempt timeout (default 5s, overridable via
// OPENKT_LLM_TIMEOUT_MS) and the timeout/network error classification.

import { ConfigService } from "@nestjs/config";

import { LlmGatewayService } from "@openkt/platform-llm";

type FetchMock = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

describe("LlmGatewayService — timeout + transient classification", () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = jest.fn() as FetchMock;
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the resolved timeout into the abort signal (5s default)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      }),
    );
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout");

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
    );
    await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(5000);
  });

  it("uses OPENKT_LLM_TIMEOUT_MS when set", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      }),
    );
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout");

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "k",
        OPENKT_LLM_TIMEOUT_MS: "8000",
      }),
    );
    await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(8000);
  });

  it("per-call timeoutMs wins over env", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      }),
    );
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout");

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "k",
        OPENKT_LLM_TIMEOUT_MS: "8000",
      }),
    );
    await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1234,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });

  it("treats AbortError as retryable timeout and retries", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchSpy
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "saved" } }] }),
          { status: 200 },
        ),
      );

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result?.text).toBe("saved");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("treats ECONNRESET as retryable", async () => {
    const econn = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    fetchSpy
      .mockRejectedValueOnce(econn)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        ),
      );

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result?.text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("records 'timeout' status when the provider call times out", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchSpy.mockRejectedValue(abortError);
    const records: Array<{ status: string; errorReason: string | null | undefined }> = [];

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      {
        record: (input) => {
          records.push({ status: input.status, errorReason: input.errorReason });
        },
      },
    );

    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBeNull();
    // One record per provider (only minimax configured).
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("timeout");
  });
});
