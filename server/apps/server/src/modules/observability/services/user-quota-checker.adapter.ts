import { Injectable, Logger } from "@nestjs/common";

import type {
  LlmQuotaChecker,
  LlmQuotaCheckResult,
} from "@openkt/platform-llm";

import { UserQuotaService } from "./user-quota.service";

/**
 * Adapter that wraps {@link UserQuotaService} (object-method API used by
 * controllers + the dashboard) and exposes the {@link LlmQuotaChecker}
 * shape that {@link LlmGatewayService} expects via the
 * `LLM_QUOTA_CHECK` injection token.
 *
 * Why an adapter rather than implementing `LlmQuotaChecker` on
 * `UserQuotaService` directly: the existing service has 3 public
 * methods (`checkAndReserve` / `commitUsage` / `getCurrentQuota`) used
 * by the existing controllers with positional-argument signatures. The
 * llm gateway interface uses single-object signatures (matching the
 * recorder pattern). Keeping both shapes via the adapter avoids
 * breaking the controller call-sites that already exist.
 *
 * Also: when the gateway needs to throw a `quota_exceeded` error, we
 * want to surface `tokensLimit` + `resetAt` so the HTTP filter can
 * include them in the JSON body. `UserQuotaService.checkAndReserve`
 * doesn't carry those out today, so we top up via `getCurrentQuota`.
 */
@Injectable()
export class UserQuotaCheckerAdapter implements LlmQuotaChecker {
  private readonly logger = new Logger(UserQuotaCheckerAdapter.name);

  constructor(private readonly userQuotas: UserQuotaService) {}

  async checkAndReserve(input: {
    userId: string;
    provider: string;
    estimatedTokens: number;
  }): Promise<LlmQuotaCheckResult> {
    const baseResult = await this.userQuotas.checkAndReserve(
      input.userId,
      input.provider,
      input.estimatedTokens,
    );

    if (baseResult.allowed) {
      return {
        allowed: true,
        reason: baseResult.reason,
        tokensRemaining: baseResult.remainingTokens,
      };
    }

    // On deny, pull a richer row so the caller can surface tokens_limit
    // and reset_at in the HTTP error.
    let tokensLimit: number | null = null;
    let resetAt: Date | null = null;
    try {
      const current = await this.userQuotas.getCurrentQuota(
        input.userId,
        input.provider,
      );
      if (current) {
        tokensLimit = current.tokens_limit;
        resetAt = new Date(current.period_end);
      }
    } catch (err) {
      // Don't let a missing window lookup mask the real signal — the
      // deny stands; we just won't have a precise reset_at in the
      // error body.
      this.logger.warn(
        `getCurrentQuota for limit/reset_at failed user=${input.userId} provider=${input.provider}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      allowed: false,
      reason: baseResult.reason,
      tokensRemaining: baseResult.remainingTokens,
      tokensLimit,
      resetAt,
    };
  }

  async commitUsage(input: {
    userId: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  }): Promise<void> {
    const actualTokens =
      Math.max(0, input.promptTokens || 0) +
      Math.max(0, input.completionTokens || 0);
    await this.userQuotas.commitUsage(
      input.userId,
      input.provider,
      actualTokens,
      input.costUsd,
    );
  }
}
