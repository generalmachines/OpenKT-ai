import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { requireOrgAccess } from "@openkt/auth-authorization";
import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import type {
  AdminAnalyticsQuery,
  OrgAnalyticsQuery,
  SelfAnalyticsQuery,
} from "../contracts/analytics.contract";

// Reads daily_user_stats / daily_org_stats and shapes the wire
// envelope. Writes happen in the worker rollup job, not here.

@Injectable()
export class AnalyticsQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async selfDailyStats(context: ActorContext, q: SelfAnalyticsQuery) {
    const userId = context.principal.userId;
    if (!userId) throw new ForbiddenDomainError("user principal required");
    const { since, until } = resolveWindow(q.since, q.until, q.days);
    const result = await this.db.execute(sql`
      select user_id, org_id, date::text as date,
             memories_created, memories_recalled, searches,
             tokens_prompt, tokens_completion, tokens_total,
             llm_calls, llm_cost_usd, projects_active,
             episodes_synthesized, mcp_tool_calls, sessions, updated_at
      from daily_user_stats
      where user_id = ${userId}::uuid
        and date >= ${since}::date
        and date <= ${until}::date
      order by date desc
    `);
    return {
      since,
      until,
      days: q.days,
      items: result.rows,
    };
  }

  async orgDailyStats(context: ActorContext, orgId: string, q: OrgAnalyticsQuery) {
    const access = await requireOrgAccess(context, orgId, "read");
    const include = parseInclude(q.include);
    const wantsBreakdown = include.has("user_breakdown");
    if (wantsBreakdown && !["owner", "admin"].includes(access.role)) {
      throw new ForbiddenDomainError("admin role required for user_breakdown");
    }
    const { since, until } = resolveWindow(q.since, q.until, q.days);
    const orgRows = await this.db.execute(sql`
      select org_id, date::text as date,
             active_users, memories_total_eod, memories_added,
             tokens_total, llm_cost_usd, top_tags, top_users, updated_at
      from daily_org_stats
      where org_id = ${orgId}::uuid
        and date >= ${since}::date
        and date <= ${until}::date
      order by date desc
    `);
    const breakdown = wantsBreakdown
      ? (
          await this.db.execute(sql`
            select user_id, date::text as date,
                   memories_created, memories_recalled, searches,
                   tokens_prompt, tokens_completion, tokens_total,
                   llm_calls, llm_cost_usd, sessions
            from daily_user_stats
            where org_id = ${orgId}::uuid
              and date >= ${since}::date
              and date <= ${until}::date
            order by date desc
          `)
        ).rows
      : undefined;
    return {
      org_id: orgId,
      since,
      until,
      days: q.days,
      items: orgRows.rows,
      user_breakdown: breakdown,
    };
  }

  async adminDailyStats(q: AdminAnalyticsQuery) {
    const { since, until } = resolveWindow(q.since, q.until, q.days);
    const totals = await this.db.execute(sql`
      select date::text as date,
             sum(active_users)::int as active_users,
             sum(memories_added)::int as memories_added,
             sum(memories_total_eod)::int as memories_total_eod,
             sum(tokens_total)::bigint as tokens_total,
             sum(llm_cost_usd)::numeric as llm_cost_usd
      from daily_org_stats
      where date >= ${since}::date
        and date <= ${until}::date
      group by date
      order by date desc
    `);
    const perOrg = await this.db.execute(sql`
      select org_id, date::text as date,
             active_users, memories_added, tokens_total, llm_cost_usd
      from daily_org_stats
      where date >= ${since}::date
        and date <= ${until}::date
      order by date desc, org_id
    `);
    return {
      since,
      until,
      days: q.days,
      totals: totals.rows,
      per_org: perOrg.rows,
    };
  }
}

function resolveWindow(
  since: string | undefined,
  until: string | undefined,
  days: number,
): { since: string; until: string } {
  const now = new Date();
  const endIso = (until ?? now.toISOString().slice(0, 10));
  const end = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) {
    return { since: endIso, until: endIso };
  }
  const startIso =
    since ??
    new Date(end.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { since: startIso, until: endIso };
}

function parseInclude(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}
