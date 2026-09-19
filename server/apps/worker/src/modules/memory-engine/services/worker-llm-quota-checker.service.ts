import { Injectable, Logger } from "@nestjs/common";

import type {
  LlmQuotaChecker,
  LlmQuotaCheckResult,
} from "@openkt/platform-llm";

import { WorkerPgService } from "../../database/worker-pg.service";

// Worker-side equivalent of `UserQuotaCheckerAdapter` on the server. The
// server uses Drizzle + `UserQuotaService`; the worker can't pull that
// module graph in, so we go direct to pg. Same `user_quotas` table.
//
// Failure modes mirror `WorkerLlmCallRecorder`: any pg error is logged
// and the gateway treats it as fail-open (allow the call). The
// rationale is that a quota DB blip MUST NOT shut down the entire
// memory pipeline — better to over-serve a few calls than block all
// of them.

// Default cap when neither the env nor an existing row provides one.
// 1M tokens/month matches the server-side default in
// `UserQuotaService.DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP`.
const DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP = 1_000_000;

const PROVIDER_DEFAULTS: Record<
  string,
  { periodKind: "monthly"; tokensLimit: number }
> = {
  minimax: {
    periodKind: "monthly",
    tokensLimit: DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP,
  },
};

@Injectable()
export class WorkerLlmQuotaChecker implements LlmQuotaChecker {
  private readonly logger = new Logger(WorkerLlmQuotaChecker.name);

  constructor(private readonly db: WorkerPgService) {}

  async checkAndReserve(input: {
    userId: string;
    provider: string;
    estimatedTokens: number;
  }): Promise<LlmQuotaCheckResult> {
    const defaults = this.providerDefaults(input.provider);
    if (!defaults) {
      // Unmetered provider — allow.
      return { allowed: true, reason: "ok", tokensRemaining: null };
    }

    const window = currentWindow(defaults.periodKind);
    const rows = await this.db.query<{
      tokens_used: string | number;
      tokens_limit: string | number;
      period_end: string;
    }>(
      `select tokens_used, tokens_limit, period_end
         from user_quotas
        where user_id = $1::uuid
          and provider = $2
          and period_kind = $3
          and period_start = $4::timestamptz
        limit 1`,
      [input.userId, input.provider, defaults.periodKind, window.start.toISOString()],
    );
    const row = rows[0];
    const used = row ? Number(row.tokens_used ?? 0) : 0;
    const limit = row
      ? Number(row.tokens_limit ?? defaults.tokensLimit)
      : defaults.tokensLimit;
    const resetAt = row ? new Date(row.period_end) : window.end;
    const projected = used + Math.max(0, input.estimatedTokens || 0);
    const remaining = Math.max(0, limit - used);

    if (projected > limit) {
      this.logger.warn(
        `[quota] worker user=${input.userId} provider=${input.provider} projected=${projected} limit=${limit} — denying`,
      );
      return {
        allowed: false,
        reason: "quota_exceeded",
        tokensRemaining: remaining,
        tokensLimit: limit,
        resetAt,
      };
    }
    return {
      allowed: true,
      reason: "ok",
      tokensRemaining: remaining,
      tokensLimit: limit,
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
    const defaults = this.providerDefaults(input.provider);
    if (!defaults) return;
    const window = currentWindow(defaults.periodKind);
    const actualTokens =
      Math.max(0, input.promptTokens || 0) +
      Math.max(0, input.completionTokens || 0);
    try {
      await this.db.query(
        `insert into user_quotas (
           user_id, provider, period_kind, period_start, period_end,
           tokens_used, tokens_limit, cost_usd_used
         ) values (
           $1::uuid, $2, $3,
           $4::timestamptz, $5::timestamptz,
           $6, $7,
           $8::numeric
         )
         on conflict (user_id, provider, period_kind, period_start)
         do update set
           tokens_used = user_quotas.tokens_used + excluded.tokens_used,
           cost_usd_used = user_quotas.cost_usd_used + excluded.cost_usd_used,
           updated_at = now()`,
        [
          input.userId,
          input.provider,
          defaults.periodKind,
          window.start.toISOString(),
          window.end.toISOString(),
          actualTokens,
          defaults.tokensLimit,
          input.costUsd.toString(),
        ],
      );
    } catch (err) {
      // Same swallow-on-error as the recorder — observability/quota
      // bookkeeping must NOT propagate into the call path.
      this.logger.warn(
        `[quota] worker commitUsage failed user=${input.userId} provider=${input.provider}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private providerDefaults(
    provider: string,
  ): { periodKind: "monthly"; tokensLimit: number } | null {
    const base = PROVIDER_DEFAULTS[provider];
    if (!base) return null;
    if (provider === "minimax") {
      const overrideRaw = process.env.OPENKT_MINIMAX_MONTHLY_TOKEN_CAP;
      const override = overrideRaw == null ? null : Number(overrideRaw);
      if (override && Number.isFinite(override) && override > 0) {
        return { periodKind: "monthly", tokensLimit: Math.floor(override) };
      }
    }
    return base;
  }
}

// Same UTC-bucket logic as `UserQuotaService.currentWindow`. Kept inline
// here so the worker doesn't need to import the server's services file.
function currentWindow(kind: "monthly" | "daily" | "lifetime"): {
  start: Date;
  end: Date;
} {
  const now = new Date();
  if (kind === "monthly") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return { start, end };
  }
  if (kind === "daily") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    return { start, end };
  }
  return {
    start: new Date(0),
    end: new Date(Date.UTC(9999, 0, 1)),
  };
}
