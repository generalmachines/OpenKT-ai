// Per-provider circuit breaker + retry helper for the LLM gateway.
//
// Semantics (per the hardening spec):
//   - state: closed | open | half_open
//   - 5 consecutive transient failures within a 60s window open the
//     circuit for 30s.
//   - In `open` state the gateway must NOT call the provider — it skips
//     directly to the fallback (the breaker reports `open` and the
//     gateway moves on without sleeping).
//   - After 30s the circuit moves to `half_open`. The next call probes
//     the provider. Success closes it; failure re-opens for another 30s.
//
// The retry policy (separate from breaker state) tries up to 3 attempts
// with `[1s, 4s, 12s]` exponential backoff and ±20% jitter when the
// provider raised a *retryable* ProviderError. 4xx-non-429 errors are
// non-retryable and propagate immediately.
//
// State is held in-memory on the gateway instance; restart resets it.
// That's deliberate — a fresh process should re-probe upstream rather
// than carry around stale breaker state from a previous deploy.

import {
  LlmProvider,
  LlmProviderId,
  ProviderCallRequest,
  ProviderCallResult,
  ProviderError,
} from "./providers/provider";

export type BreakerState = "closed" | "open" | "half_open";

export interface ProviderStats {
  state: BreakerState;
  // Failure timestamps within the rolling window (ms epoch). Trimmed
  // to the last `FAILURE_WINDOW_MS` on every record.
  recentFailures: number[];
  openedAt: number | null;
  lastError: string | null;
}

export interface CircuitBreakerOptions {
  failureThreshold: number; // default 5
  failureWindowMs: number; // default 60_000
  openCooldownMs: number; // default 30_000
  retryDelaysMs: number[]; // default [1000, 4000, 12000]
  jitterFraction: number; // default 0.2
  maxAttempts: number; // default 3
  // Sleep impl — injectable so tests can fake delays without burning
  // real time. Returns a promise that resolves after `ms`.
  sleep?: (ms: number) => Promise<void>;
  // Clock — injectable so tests can advance time deterministically.
  now?: () => number;
  // Random source for jitter — injectable to make tests deterministic.
  random?: () => number;
}

export const CIRCUIT_BREAKER_DEFAULTS: CircuitBreakerOptions = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  openCooldownMs: 30_000,
  retryDelaysMs: [1_000, 4_000, 12_000],
  jitterFraction: 0.2,
  maxAttempts: 3,
};

export interface AttemptOutcomeSuccess {
  kind: "success";
  result: ProviderCallResult;
  attempts: number;
}

export interface AttemptOutcomeFailure {
  kind: "failure";
  reason: "circuit_open" | "exhausted" | "non_retryable";
  error: ProviderError | null;
  attempts: number;
}

export type AttemptOutcome = AttemptOutcomeSuccess | AttemptOutcomeFailure;

export class CircuitBreaker {
  private readonly opts: Required<CircuitBreakerOptions>;
  private readonly stats: Map<LlmProviderId, ProviderStats> = new Map();

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    // Build with explicit fallbacks so `Required<X>` actually holds —
    // `{ ...defaults, ...options }` would set fields to undefined when
    // the caller omits an optional override.
    this.opts = {
      failureThreshold:
        options.failureThreshold ?? CIRCUIT_BREAKER_DEFAULTS.failureThreshold,
      failureWindowMs:
        options.failureWindowMs ?? CIRCUIT_BREAKER_DEFAULTS.failureWindowMs,
      openCooldownMs:
        options.openCooldownMs ?? CIRCUIT_BREAKER_DEFAULTS.openCooldownMs,
      retryDelaysMs:
        options.retryDelaysMs ?? CIRCUIT_BREAKER_DEFAULTS.retryDelaysMs,
      jitterFraction:
        options.jitterFraction ?? CIRCUIT_BREAKER_DEFAULTS.jitterFraction,
      maxAttempts:
        options.maxAttempts ?? CIRCUIT_BREAKER_DEFAULTS.maxAttempts,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? defaultNow,
      random: options.random ?? Math.random,
    };
  }

  // Public for tests / observability.
  getState(providerId: LlmProviderId): BreakerState {
    return this.peek(providerId).state;
  }

  getStats(providerId: LlmProviderId): ProviderStats {
    return { ...this.peek(providerId), recentFailures: [...this.peek(providerId).recentFailures] };
  }

  // Reset is intentionally exposed — useful in tests and in the
  // unlikely case operations need to manually re-probe a provider.
  reset(providerId?: LlmProviderId): void {
    if (providerId) {
      this.stats.delete(providerId);
    } else {
      this.stats.clear();
    }
  }

  // Runs `provider.generate(request)` through the breaker + retry. On
  // success returns `{kind:'success'}`. On terminal failure returns
  // `{kind:'failure'}` carrying the last error and reason — the gateway
  // decides whether to fall back to the next provider.
  async run(
    provider: LlmProvider,
    request: ProviderCallRequest,
  ): Promise<AttemptOutcome> {
    const state = this.transitionForCall(provider.id);
    if (state === "open") {
      return {
        kind: "failure",
        reason: "circuit_open",
        error: null,
        attempts: 0,
      };
    }

    let lastError: ProviderError | null = null;
    let attempt = 0;

    while (attempt < this.opts.maxAttempts) {
      attempt += 1;
      try {
        const result = await provider.generate(request);
        this.recordSuccess(provider.id);
        return { kind: "success", result, attempts: attempt };
      } catch (err) {
        const providerErr = toProviderError(err, provider.id);
        lastError = providerErr;

        if (!providerErr.retryable) {
          // 4xx-non-429: don't retry, don't count toward circuit (the
          // provider isn't degraded — the caller sent a bad request).
          return {
            kind: "failure",
            reason: "non_retryable",
            error: providerErr,
            attempts: attempt,
          };
        }

        this.recordFailure(provider.id, providerErr.message);

        // If this failure tripped the breaker, bail out immediately —
        // no point retrying when the breaker just said "stop hitting it".
        if (this.peek(provider.id).state === "open") {
          return {
            kind: "failure",
            reason: "exhausted",
            error: providerErr,
            attempts: attempt,
          };
        }

        if (attempt >= this.opts.maxAttempts) break;

        const delay = this.jitter(
          this.opts.retryDelaysMs[
            Math.min(attempt - 1, this.opts.retryDelaysMs.length - 1)
          ],
        );
        await this.opts.sleep(delay);
      }
    }

    return {
      kind: "failure",
      reason: "exhausted",
      error: lastError,
      attempts: attempt,
    };
  }

  private jitter(baseMs: number): number {
    const span = baseMs * this.opts.jitterFraction;
    // random() in [0,1) → offset in [-span, +span)
    const offset = (this.opts.random() * 2 - 1) * span;
    return Math.max(0, Math.round(baseMs + offset));
  }

  // Move state forward as a side-effect of calling. Returns the state
  // observed *for this call*: if the cooldown has elapsed an `open`
  // breaker flips to `half_open` and we let the call through.
  private transitionForCall(providerId: LlmProviderId): BreakerState {
    const stats = this.peek(providerId);
    if (stats.state === "open" && stats.openedAt !== null) {
      const elapsed = this.opts.now() - stats.openedAt;
      if (elapsed >= this.opts.openCooldownMs) {
        stats.state = "half_open";
        stats.openedAt = null;
      }
    }
    return stats.state;
  }

  private recordSuccess(providerId: LlmProviderId): void {
    const stats = this.peek(providerId);
    // Any success — closed or half-open — closes the circuit and
    // wipes the failure history.
    stats.state = "closed";
    stats.openedAt = null;
    stats.recentFailures = [];
    stats.lastError = null;
  }

  private recordFailure(providerId: LlmProviderId, errorMessage: string): void {
    const stats = this.peek(providerId);
    const now = this.opts.now();
    stats.lastError = errorMessage;

    // Half-open + failure → straight back to open with a fresh cooldown
    // and a fresh failure window (one strike, not five, because we
    // just probed and got burned).
    if (stats.state === "half_open") {
      stats.state = "open";
      stats.openedAt = now;
      stats.recentFailures = [now];
      return;
    }

    // Closed state: append, trim window, maybe trip.
    stats.recentFailures.push(now);
    const cutoff = now - this.opts.failureWindowMs;
    stats.recentFailures = stats.recentFailures.filter((t) => t > cutoff);

    if (stats.recentFailures.length >= this.opts.failureThreshold) {
      stats.state = "open";
      stats.openedAt = now;
    }
  }

  private peek(providerId: LlmProviderId): ProviderStats {
    let stats = this.stats.get(providerId);
    if (!stats) {
      stats = {
        state: "closed",
        recentFailures: [],
        openedAt: null,
        lastError: null,
      };
      this.stats.set(providerId, stats);
    }
    return stats;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultNow(): number {
  return Date.now();
}

function toProviderError(err: unknown, providerId: LlmProviderId): ProviderError {
  if (err instanceof ProviderError) return err;
  // Anything else from a provider is treated as a non-retryable bug —
  // we don't want to mask programmer errors as transient outages.
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown_error";
  return new ProviderError({
    providerId,
    message: message.slice(0, 240),
    status: 0,
    retryable: false,
    code: "unexpected",
  });
}
