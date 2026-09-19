// LLM gateway error types.
//
// The existing call sites in OpenKT all use the `tryGenerate*` family
// which returns `null` on failure rather than throwing — so adding a
// new error class doesn't change observable behavior for those
// callers. It exists for:
//   - tests that want to assert on which path failed.
//   - future call sites that prefer exceptions over null sentinels.

import type { LlmProviderId } from "./providers/provider";

export interface ProviderAttemptSummary {
  provider: LlmProviderId;
  reason: "circuit_open" | "exhausted" | "non_retryable" | "unconfigured";
  status: number | null;
  message: string | null;
  attempts: number;
}

export class LlmProvidersExhaustedError extends Error {
  readonly attempts: ProviderAttemptSummary[];

  constructor(attempts: ProviderAttemptSummary[]) {
    const chain = attempts.map((a) => a.provider).join(" → ") || "(none)";
    super(`All LLM providers failed: ${chain}`);
    this.name = "LlmProvidersExhaustedError";
    this.attempts = attempts;
  }
}

// Terminal, per-user quota gate. Surfaced as 429 at the HTTP layer. We
// keep it separate from `LlmProvidersExhaustedError` so the fallback
// chain never tries to "recover" from a quota miss — quota is keyed to
// the user, not the provider, so trying the next provider would just
// burn another bucket without helping.
export class LlmQuotaExceededError extends Error {
  readonly code = "quota_exceeded";
  readonly tokensLimit: number | null;
  readonly tokensRemaining: number | null;
  readonly tokensUsed: number | null;
  readonly resetAt: Date | null;
  readonly reason: string | null;
  readonly provider: string;

  constructor(input: {
    provider: string;
    tokensLimit?: number | null;
    tokensRemaining?: number | null;
    tokensUsed?: number | null;
    resetAt?: Date | null;
    reason?: string | null;
  }) {
    const limit = input.tokensLimit ?? null;
    super(
      `LLM quota exceeded for provider=${input.provider}` +
        (limit != null ? ` (limit=${limit})` : ""),
    );
    this.name = "LlmQuotaExceededError";
    this.provider = input.provider;
    this.tokensLimit = limit;
    this.tokensRemaining = input.tokensRemaining ?? null;
    this.tokensUsed =
      input.tokensUsed ??
      (limit != null && input.tokensRemaining != null
        ? Math.max(0, limit - input.tokensRemaining)
        : null);
    this.resetAt = input.resetAt ?? null;
    this.reason = input.reason ?? null;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      provider: this.provider,
      tokens_limit: this.tokensLimit,
      tokens_used: this.tokensUsed,
      tokens_remaining: this.tokensRemaining,
      reset_at: this.resetAt ? this.resetAt.toISOString() : null,
      reason: this.reason,
    };
  }
}
