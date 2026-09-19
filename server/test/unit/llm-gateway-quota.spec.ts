// Unit tests for the per-user token-quota gate wired into
// LlmGatewayService via the `LLM_QUOTA_CHECK` injection. Mirrors the
// LLM_CALL_RECORDER test pattern — stub `global.fetch` for the provider
// and pass a fake quota checker as a constructor argument.

import { ConfigService } from "@nestjs/config";

import {
  LlmGatewayService,
  LlmQuotaExceededError,
  runWithLlmCallContext,
  type LlmQuotaChecker,
  type LlmQuotaCheckResult,
} from "@openkt/platform-llm";

type FetchMock = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatOk(text: string, usage = { prompt_tokens: 42, completion_tokens: 7 }): Response {
  return jsonResponse({
    choices: [{ message: { content: text } }],
    usage,
  });
}

interface RecordedCheck {
  userId: string;
  provider: string;
  estimatedTokens: number;
}

interface RecordedCommit {
  userId: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

function makeQuotaChecker(opts: {
  checkResult?:
    | LlmQuotaCheckResult
    | ((input: RecordedCheck) => LlmQuotaCheckResult);
  checkThrows?: Error;
  commitThrows?: Error;
}): {
  checker: LlmQuotaChecker;
  checks: RecordedCheck[];
  commits: RecordedCommit[];
} {
  const checks: RecordedCheck[] = [];
  const commits: RecordedCommit[] = [];
  const checker: LlmQuotaChecker = {
    async checkAndReserve(input) {
      checks.push(input);
      if (opts.checkThrows) throw opts.checkThrows;
      const result = opts.checkResult ?? { allowed: true };
      return typeof result === "function" ? result(input) : result;
    },
    async commitUsage(input) {
      commits.push(input);
      if (opts.commitThrows) throw opts.commitThrows;
    },
  };
  return { checker, checks, commits };
}

describe("LlmGatewayService — quota enforcement", () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = jest.fn() as FetchMock;
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("throws LlmQuotaExceededError when checkAndReserve returns allowed=false and never hits the provider", async () => {
    const { checker, checks, commits } = makeQuotaChecker({
      checkResult: {
        allowed: false,
        tokensLimit: 1_000_000,
        tokensRemaining: 0,
        resetAt: new Date("2026-06-01T00:00:00Z"),
        reason: "quota_exceeded",
      },
    });

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      undefined,
      checker,
    );

    let caught: unknown = null;
    await runWithLlmCallContext({ stage: "manual", userId: "u-123" }, async () => {
      try {
        await gateway.tryGenerateText({
          messages: [{ role: "user", content: "hello" }],
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(LlmQuotaExceededError);
    const quotaErr = caught as LlmQuotaExceededError;
    expect(quotaErr.tokensLimit).toBe(1_000_000);
    expect(quotaErr.tokensRemaining).toBe(0);
    expect(quotaErr.resetAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(quotaErr.provider).toBe("minimax");

    // Provider was never called.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Checker was called exactly once, with the userId from context.
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({
      userId: "u-123",
      provider: "minimax",
      estimatedTokens: expect.any(Number),
    });
    // commitUsage was NOT called — nothing to debit.
    expect(commits).toHaveLength(0);
  });

  it("calls the provider and commits actual token counts when allowed", async () => {
    fetchSpy.mockResolvedValueOnce(
      chatOk("hi there", { prompt_tokens: 42, completion_tokens: 7 }),
    );

    const { checker, checks, commits } = makeQuotaChecker({
      checkResult: { allowed: true, tokensRemaining: 999_950, tokensLimit: 1_000_000 },
    });

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      undefined,
      checker,
    );

    const result = await runWithLlmCallContext(
      { stage: "manual", userId: "u-456" },
      () =>
        gateway.tryGenerateText({
          messages: [{ role: "user", content: "hi" }],
        }),
    );

    expect(result?.text).toBe("hi there");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    expect(checks).toHaveLength(1);
    expect(checks[0].userId).toBe("u-456");
    expect(checks[0].provider).toBe("minimax");

    // commitUsage carries the *actual* token counts from the provider
    // response — not the estimate.
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual(
      expect.objectContaining({
        userId: "u-456",
        provider: "minimax",
        promptTokens: 42,
        completionTokens: 7,
      }),
    );
    expect(typeof commits[0].costUsd).toBe("number");
    expect(commits[0].costUsd).toBeGreaterThanOrEqual(0);
  });

  it("fails open and proceeds with the provider call when checkAndReserve throws", async () => {
    fetchSpy.mockResolvedValueOnce(chatOk("served despite quota error"));

    const { checker, checks } = makeQuotaChecker({
      checkThrows: new Error("connection refused"),
    });

    // Spy on Logger.warn to ensure we logged.
    const warnSpy = jest
      .spyOn(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("@nestjs/common").Logger.prototype,
        "warn",
      )
      .mockImplementation(() => {});

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      undefined,
      checker,
    );

    const result = await runWithLlmCallContext(
      { stage: "manual", userId: "u-789" },
      () =>
        gateway.tryGenerateText({
          messages: [{ role: "user", content: "hi" }],
        }),
    );

    // Provider was called even though the quota checker errored.
    expect(result?.text).toBe("served despite quota error");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(1);
    // We logged the warning.
    const warned = warnSpy.mock.calls.some((call) =>
      String(call[0] ?? "").includes("[quota] checkAndReserve failed"),
    );
    expect(warned).toBe(true);

    warnSpy.mockRestore();
  });

  it("skips the quota check when no userId is in context (system calls)", async () => {
    fetchSpy.mockResolvedValueOnce(chatOk("system call ok"));

    const { checker, checks, commits } = makeQuotaChecker({
      checkResult: { allowed: false }, // would deny if we asked
    });

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      undefined,
      checker,
    );

    // Note: no AsyncLocalStorage wrapper — context is undefined.
    const result = await gateway.tryGenerateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result?.text).toBe("system call ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Quota checker was NEVER consulted.
    expect(checks).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });

  it("skips the quota check when context has stage but no userId", async () => {
    fetchSpy.mockResolvedValueOnce(chatOk("anon ok"));

    const { checker, checks } = makeQuotaChecker({
      checkResult: { allowed: false },
    });

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      undefined,
      checker,
    );

    const result = await runWithLlmCallContext(
      { stage: "manual", userId: null },
      () =>
        gateway.tryGenerateText({
          messages: [{ role: "user", content: "hi" }],
        }),
    );

    expect(result?.text).toBe("anon ok");
    expect(checks).toHaveLength(0);
  });

  it("works without a quota checker bound at all (legacy / standalone)", async () => {
    fetchSpy.mockResolvedValueOnce(chatOk("legacy"));

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      // no recorder, no checker
    );

    const result = await runWithLlmCallContext(
      { stage: "manual", userId: "u-legacy" },
      () =>
        gateway.tryGenerateText({
          messages: [{ role: "user", content: "hi" }],
        }),
    );

    expect(result?.text).toBe("legacy");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back to a second provider when quota denies on the primary", async () => {
    // Both providers configured. If quota deny tried to "fall back" we'd
    // see openai called — we shouldn't.
    const { checker, checks } = makeQuotaChecker({
      checkResult: {
        allowed: false,
        tokensLimit: 1_000_000,
        tokensRemaining: 0,
      },
    });

    const gateway = new LlmGatewayService(
      makeConfig({
        OPENKT_DEFAULT_LLM_KEY: "minimax-key",
        OPENKT_OPENAI_API_KEY: "openai-key",
      }),
      undefined,
      checker,
    );

    let caught: unknown = null;
    await runWithLlmCallContext({ stage: "manual", userId: "u-q" }, async () => {
      try {
        await gateway.tryGenerateText({
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(LlmQuotaExceededError);
    expect((caught as LlmQuotaExceededError).provider).toBe("minimax");
    // Only the primary was even consulted; no provider call landed.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Quota was only checked once (we exit before trying openai).
    expect(checks).toHaveLength(1);
    expect(checks[0].provider).toBe("minimax");
  });

  it("commitUsage swallows its own errors without failing the call", async () => {
    fetchSpy.mockResolvedValueOnce(chatOk("ok"));

    const { checker, commits } = makeQuotaChecker({
      checkResult: { allowed: true },
      commitThrows: new Error("db connection lost"),
    });

    const gateway = new LlmGatewayService(
      makeConfig({ OPENKT_DEFAULT_LLM_KEY: "k" }),
      undefined,
      checker,
    );

    const result = await runWithLlmCallContext(
      { stage: "manual", userId: "u-commit-err" },
      () =>
        gateway.tryGenerateText({
          messages: [{ role: "user", content: "hi" }],
        }),
    );

    // The text came back; the failed commit must not have surfaced.
    expect(result?.text).toBe("ok");
    expect(commits).toHaveLength(1); // commit was attempted
  });
});
