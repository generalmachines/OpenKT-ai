import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// Initial MiniMax free-tier limit: 1,000,000 tokens / user / month.
// Overridable via env so staging can be turned down to flush bugs out
// of the enforcement path.
export const DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP = 1_000_000;
export const QUOTA_PROVIDER_DEFAULTS: Record<
  string,
  { periodKind: "monthly"; tokensLimit: number }
> = {
  minimax: {
    periodKind: "monthly",
    tokensLimit: DEFAULT_MINIMAX_MONTHLY_TOKEN_CAP,
  },
};

export interface QuotaCheckResult {
  allowed: boolean;
  reason: "ok" | "no_user" | "quota_exceeded";
  remainingTokens: number | null;
}

@Injectable()
export class UserQuotaService {
  private readonly logger = new Logger(UserQuotaService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
  ) {}

  // Returns true when the call is under quota, false when it would
  // exceed. Per the spec we DO NOT reject when over quota — we log a
  // warning and let the caller proceed but mark the row 'quota_exceeded'.
  // The boolean is still surfaced so callers can choose to add a hard
  // gate later via OPENKT_QUOTA_HARD_REJECT (future toggle).
  async checkAndReserve(
    userId: string | null | undefined,
    provider: string,
    estimatedTokens: number,
  ): Promise<QuotaCheckResult> {
    if (!userId) {
      return { allowed: true, reason: "no_user", remainingTokens: null };
    }

    const defaults = this.providerDefaults(provider);
    if (!defaults) {
      return { allowed: true, reason: "ok", remainingTokens: null };
    }

    const window = currentWindow(defaults.periodKind);
    const existing = await this.db.execute(sql`
      select tokens_used, tokens_limit
      from user_quotas
      where user_id = ${userId}::uuid
        and provider = ${provider}
        and period_kind = ${defaults.periodKind}
        and period_start = ${window.start.toISOString()}::timestamptz
      limit 1
    `);
    const row = existing.rows[0] as { tokens_used: string | number; tokens_limit: string | number } | undefined;
    const used = row ? Number(row.tokens_used ?? 0) : 0;
    const limit = row ? Number(row.tokens_limit ?? defaults.tokensLimit) : defaults.tokensLimit;
    const projected = used + Math.max(0, estimatedTokens || 0);
    const remaining = Math.max(0, limit - used);

    if (projected > limit) {
      this.logger.warn(
        `[quota] user=${userId} provider=${provider} period=${defaults.periodKind} projected=${projected} limit=${limit} — degrading but allowing`,
      );
      return { allowed: false, reason: "quota_exceeded", remainingTokens: remaining };
    }

    return { allowed: true, reason: "ok", remainingTokens: remaining };
  }

  // Idempotently upsert (user, provider, period_kind, period_start) and
  // bump tokens_used + cost_usd_used. Safe to call from concurrent
  // workers because of the unique index + ON CONFLICT.
  async commitUsage(
    userId: string | null | undefined,
    provider: string,
    actualTokens: number,
    costUsd: number,
  ): Promise<void> {
    if (!userId) return;
    const defaults = this.providerDefaults(provider);
    if (!defaults) return;

    const window = currentWindow(defaults.periodKind);
    try {
      await this.db.execute(sql`
        insert into user_quotas (
          user_id, provider, period_kind, period_start, period_end,
          tokens_used, tokens_limit, cost_usd_used
        ) values (
          ${userId}::uuid,
          ${provider},
          ${defaults.periodKind},
          ${window.start.toISOString()}::timestamptz,
          ${window.end.toISOString()}::timestamptz,
          ${Math.max(0, actualTokens || 0)},
          ${defaults.tokensLimit},
          ${costUsd.toString()}::numeric
        )
        on conflict (user_id, provider, period_kind, period_start)
        do update set
          tokens_used = user_quotas.tokens_used + excluded.tokens_used,
          cost_usd_used = user_quotas.cost_usd_used + excluded.cost_usd_used,
          updated_at = now()
      `);
    } catch (err) {
      this.logger.warn(
        `commitUsage failed for user=${userId} provider=${provider}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getCurrentQuota(
    userId: string,
    provider = "minimax",
  ): Promise<{
    user_id: string;
    provider: string;
    period_kind: "monthly" | "daily" | "lifetime";
    period_start: string;
    period_end: string;
    tokens_used: number;
    tokens_limit: number;
    cost_usd_used: number;
    cost_usd_limit: number | null;
  } | null> {
    const defaults = this.providerDefaults(provider);
    if (!defaults) return null;
    const window = currentWindow(defaults.periodKind);
    const result = await this.db.execute(sql`
      select user_id, provider, period_kind, period_start, period_end,
             tokens_used, tokens_limit, cost_usd_used, cost_usd_limit
      from user_quotas
      where user_id = ${userId}::uuid
        and provider = ${provider}
        and period_kind = ${defaults.periodKind}
        and period_start = ${window.start.toISOString()}::timestamptz
      limit 1
    `);
    const row = result.rows[0];
    if (row) {
      return {
        user_id: row.user_id as string,
        provider: row.provider as string,
        period_kind: row.period_kind as "monthly" | "daily" | "lifetime",
        period_start: new Date(row.period_start as string).toISOString(),
        period_end: new Date(row.period_end as string).toISOString(),
        tokens_used: Number(row.tokens_used ?? 0),
        tokens_limit: Number(row.tokens_limit ?? defaults.tokensLimit),
        cost_usd_used: Number(row.cost_usd_used ?? 0),
        cost_usd_limit: row.cost_usd_limit == null ? null : Number(row.cost_usd_limit),
      };
    }
    // Synthetic empty-state response so the dashboard always has a
    // window+limit to show even when the user hasn't spent a token yet.
    return {
      user_id: userId,
      provider,
      period_kind: defaults.periodKind,
      period_start: window.start.toISOString(),
      period_end: window.end.toISOString(),
      tokens_used: 0,
      tokens_limit: defaults.tokensLimit,
      cost_usd_used: 0,
      cost_usd_limit: null,
    };
  }

  private providerDefaults(
    provider: string,
  ): { periodKind: "monthly"; tokensLimit: number } | null {
    const base = QUOTA_PROVIDER_DEFAULTS[provider];
    if (!base) return null;
    if (provider === "minimax") {
      const overrideRaw = this.configService.get<string | number>(
        "OPENKT_MINIMAX_MONTHLY_TOKEN_CAP",
      );
      const override = overrideRaw == null ? null : Number(overrideRaw);
      if (override && Number.isFinite(override) && override > 0) {
        return { periodKind: "monthly", tokensLimit: Math.floor(override) };
      }
    }
    return base;
  }
}

// Window helpers — UTC month/day buckets so the period_start key is
// stable across regions.
export function currentWindow(kind: "monthly" | "daily" | "lifetime"): {
  start: Date;
  end: Date;
} {
  const now = new Date();
  if (kind === "monthly") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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
