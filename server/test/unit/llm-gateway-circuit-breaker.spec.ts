// Unit tests for the per-provider circuit breaker state machine.
//
// These tests use a fake clock + fake sleep so the state transitions
// can be driven deterministically without waiting on real timers.

import {
  CircuitBreaker,
  ProviderError,
  type LlmProviderInterface,
  type LlmProviderId,
  type ProviderCallRequest,
  type ProviderCallResult,
} from "@openkt/platform-llm";

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function makeClock(start = 1_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface StubProviderOptions {
  id?: LlmProviderId;
  outcomes: Array<"success" | "retryable" | "non_retryable">;
}

function makeStubProvider(opts: StubProviderOptions): LlmProviderInterface & { calls: number } {
  let i = 0;
  const provider: LlmProviderInterface & { calls: number } = {
    id: opts.id ?? "minimax",
    calls: 0,
    isConfigured: () => true,
    async generate(_req: ProviderCallRequest): Promise<ProviderCallResult> {
      provider.calls += 1;
      const outcome = opts.outcomes[i] ?? opts.outcomes[opts.outcomes.length - 1];
      i += 1;
      if (outcome === "success") {
        return {
          text: "ok",
          usage: { promptTokens: 1, completionTokens: 1 },
          model: "stub-model",
          raw: {},
        };
      }
      if (outcome === "retryable") {
        throw new ProviderError({
          providerId: provider.id,
          message: "upstream 502",
          status: 502,
          retryable: true,
          code: "http_502",
        });
      }
      throw new ProviderError({
        providerId: provider.id,
        message: "bad request",
        status: 400,
        retryable: false,
        code: "http_400",
      });
    },
  };
  return provider;
}

function dummyRequest(): ProviderCallRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    timeoutMs: 5000,
  };
}

describe("CircuitBreaker", () => {
  let clock: FakeClock;
  let sleeps: number[];

  beforeEach(() => {
    clock = makeClock();
    sleeps = [];
  });

  function makeBreaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
    return new CircuitBreaker({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: clock.now,
      random: () => 0.5, // deterministic — jitter offset = 0
      ...overrides,
    });
  }

  describe("state transitions", () => {
    it("starts in closed state and stays closed on success", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({ outcomes: ["success"] });

      expect(breaker.getState("minimax")).toBe("closed");

      const outcome = await breaker.run(provider, dummyRequest());
      expect(outcome.kind).toBe("success");
      expect(breaker.getState("minimax")).toBe("closed");
    });

    it("trips to open after 5 retryable failures inside the 60s window", async () => {
      const breaker = makeBreaker();
      // Each `run()` performs up to maxAttempts (3) retries; each
      // retryable upstream error records ONE failure toward the
      // breaker's window. So one run that exhausts retries records 3
      // failures. A second run records two more before the 5th
      // failure trips the breaker mid-retry → bail.
      const provider = makeStubProvider({
        outcomes: Array(10).fill("retryable"),
      });

      // First run: 3 retryable failures recorded. Still under threshold.
      await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("closed");

      // Second run: records 4th + 5th, breaker opens, bails.
      const second = await breaker.run(provider, dummyRequest());
      expect(second.kind).toBe("failure");
      expect(breaker.getState("minimax")).toBe("open");
    });

    it("returns circuit_open without calling the provider when state=open", async () => {
      const breaker = makeBreaker();
      const failing = makeStubProvider({ outcomes: Array(20).fill("retryable") });

      // Two runs are enough to record 5 individual retryable failures
      // (3 + 2 = 5 → trip on the 2nd run mid-retry).
      await breaker.run(failing, dummyRequest());
      await breaker.run(failing, dummyRequest());
      expect(breaker.getState("minimax")).toBe("open");

      // Next call must short-circuit.
      const callsBefore = failing.calls;
      const outcome = await breaker.run(failing, dummyRequest());
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason).toBe("circuit_open");
        expect(outcome.attempts).toBe(0);
      }
      expect(failing.calls).toBe(callsBefore);
    });

    it("flips from open → half_open after the 30s cooldown elapses", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: [
          ...Array(5).fill("retryable"),
          "success",
        ],
      });

      // Two runs records 5 failures and trips the breaker.
      await breaker.run(provider, dummyRequest());
      await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("open");

      // 29s — still open.
      clock.advance(29_000);
      const stillOpen = await breaker.run(provider, dummyRequest());
      expect(stillOpen.kind).toBe("failure");
      if (stillOpen.kind === "failure") {
        expect(stillOpen.reason).toBe("circuit_open");
      }

      // Now cross the 30s cooldown.
      clock.advance(1_500);
      const probe = await breaker.run(provider, dummyRequest());
      expect(probe.kind).toBe("success");
      // Success in half_open → closed.
      expect(breaker.getState("minimax")).toBe("closed");
    });

    it("half_open + failure re-opens the circuit", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: Array(20).fill("retryable"),
      });

      await breaker.run(provider, dummyRequest());
      await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("open");

      clock.advance(31_000);
      const probe = await breaker.run(provider, dummyRequest());
      expect(probe.kind).toBe("failure");
      expect(breaker.getState("minimax")).toBe("open");
    });

    it("doesn't trip on non_retryable errors (4xx, not 429)", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: Array(10).fill("non_retryable"),
      });

      for (let i = 0; i < 6; i++) {
        const outcome = await breaker.run(provider, dummyRequest());
        expect(outcome.kind).toBe("failure");
        if (outcome.kind === "failure") {
          expect(outcome.reason).toBe("non_retryable");
        }
      }
      // 4xx never counts as a degradation signal.
      expect(breaker.getState("minimax")).toBe("closed");
    });

    it("rolls failures off after the 60s window", async () => {
      // Bump the threshold so a single run() (which records up to 3
      // failures via retries) can't trip the breaker — that way we
      // can verify the windowing behaviour cleanly.
      const breaker = makeBreaker({ failureThreshold: 10 });
      const provider = makeStubProvider({
        outcomes: Array(40).fill("retryable"),
      });

      // 3 runs → 9 failures inside window.
      for (let i = 0; i < 3; i++) await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("closed");

      // Advance past window.
      clock.advance(60_001);
      // 3 more runs → 9 more failures. The previous 9 should have
      // aged out, so 9 < 10 → still closed.
      for (let i = 0; i < 3; i++) await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("closed");

      // One more → 10 inside window → opens (mid-retry on the 10th).
      await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("open");
    });

    it("isolates state per provider id", async () => {
      const breaker = makeBreaker();
      const minimax = makeStubProvider({
        id: "minimax",
        outcomes: Array(20).fill("retryable"),
      });
      const openai = makeStubProvider({
        id: "openai",
        outcomes: ["success"],
      });

      // Two runs is enough to trip minimax (3 + 2 = 5 failures).
      await breaker.run(minimax, dummyRequest());
      await breaker.run(minimax, dummyRequest());
      expect(breaker.getState("minimax")).toBe("open");
      expect(breaker.getState("openai")).toBe("closed");

      const ok = await breaker.run(openai, dummyRequest());
      expect(ok.kind).toBe("success");
    });
  });

  describe("retry policy", () => {
    it("retries retryable errors up to maxAttempts (3) with backoff", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: ["retryable", "retryable", "success"],
      });

      const outcome = await breaker.run(provider, dummyRequest());
      expect(outcome.kind).toBe("success");
      if (outcome.kind === "success") {
        expect(outcome.attempts).toBe(3);
      }
      expect(provider.calls).toBe(3);
      // Two sleeps between three attempts: 1s and 4s (jitter=0).
      expect(sleeps).toEqual([1000, 4000]);
    });

    it("gives up after 3 attempts when all retryable", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: Array(5).fill("retryable"),
      });

      const outcome = await breaker.run(provider, dummyRequest());
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason).toBe("exhausted");
        expect(outcome.attempts).toBe(3);
      }
      expect(provider.calls).toBe(3);
    });

    it("does NOT retry non_retryable errors", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: ["non_retryable", "success"],
      });

      const outcome = await breaker.run(provider, dummyRequest());
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason).toBe("non_retryable");
        expect(outcome.attempts).toBe(1);
      }
      expect(provider.calls).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it("applies ±20% jitter to the backoff delay", async () => {
      // random=0.0 → offset = -span; random=1.0 → +span
      const breakerLow = new CircuitBreaker({
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: clock.now,
        random: () => 0.0,
      });
      const provider = makeStubProvider({
        outcomes: ["retryable", "retryable", "success"],
      });
      await breakerLow.run(provider, dummyRequest());
      // 1000 - 200 = 800; 4000 - 800 = 3200
      expect(sleeps).toEqual([800, 3200]);

      sleeps = [];
      const breakerHigh = new CircuitBreaker({
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: clock.now,
        random: () => 0.99999,
      });
      const provider2 = makeStubProvider({
        outcomes: ["retryable", "retryable", "success"],
      });
      await breakerHigh.run(provider2, dummyRequest());
      // 1000 + ~200 → 1200; 4000 + ~800 → 4800
      expect(sleeps[0]).toBeGreaterThanOrEqual(1199);
      expect(sleeps[0]).toBeLessThanOrEqual(1200);
      expect(sleeps[1]).toBeGreaterThanOrEqual(4799);
      expect(sleeps[1]).toBeLessThanOrEqual(4800);
    });

    it("bails immediately when a retryable failure trips the breaker", async () => {
      // With threshold=2, the breaker should trip on the 2nd retryable
      // attempt of a single run() — proving the breaker check inside
      // the retry loop short-circuits the remaining attempts.
      const breaker = makeBreaker({ failureThreshold: 2 });
      const provider = makeStubProvider({
        outcomes: Array(5).fill("retryable"),
      });
      const outcome = await breaker.run(provider, dummyRequest());
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason).toBe("exhausted");
        // 2 attempts: the 2nd one trips the breaker so the 3rd never
        // runs.
        expect(outcome.attempts).toBe(2);
      }
      expect(provider.calls).toBe(2);
      expect(breaker.getState("minimax")).toBe("open");
    });
  });

  describe("reset", () => {
    it("clears state for one or all providers", async () => {
      const breaker = makeBreaker();
      const provider = makeStubProvider({
        outcomes: Array(20).fill("retryable"),
      });
      await breaker.run(provider, dummyRequest());
      await breaker.run(provider, dummyRequest());
      expect(breaker.getState("minimax")).toBe("open");

      breaker.reset("minimax");
      expect(breaker.getState("minimax")).toBe("closed");
    });
  });
});
