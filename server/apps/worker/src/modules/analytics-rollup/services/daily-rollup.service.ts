import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { WorkerPgService } from "../../database/worker-pg.service";

// daily-rollup service — hourly walk of analytics_events for the
// current UTC day → upsert per-user counts + token sums (from
// llm_calls) into daily_user_stats → derive daily_org_stats from
// daily_user_stats. Idempotent: re-running overwrites the day.
//
// TODO(scheduler): no @nestjs/schedule in this app yet; we run on
// a plain setInterval. Replace with cron once a proper scheduler
// lands. For now the orchestrator can also call rollupDay()
// manually via a one-off `ts-node` script.

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class DailyRollupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyRollupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly pg: WorkerPgService) {}

  onModuleInit(): void {
    if (process.env.OPENKT_DISABLE_ANALYTICS_ROLLUP === "1") {
      this.logger.log("analytics rollup disabled by env");
      return;
    }
    // Run once on boot and then every hour. The job is cheap
    // (single-day UTC slice, indexed user/org lookups) and idempotent.
    setImmediate(() => this.runSafe());
    this.timer = setInterval(() => this.runSafe(), HOUR_MS);
    this.logger.log("analytics rollup scheduled (hourly)");
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runSafe(): Promise<void> {
    try {
      const today = currentUtcDay();
      await this.rollupDay(today);
      this.logger.log(`rolled up analytics for ${today}`);
    } catch (err) {
      this.logger.error(
        `rollup tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Public so an orchestrator (or a test) can run a day on demand.
  // Idempotent — re-running for the same UTC day overwrites.
  async rollupDay(date: string): Promise<void> {
    await this.rollupUserStats(date);
    await this.rollupOrgStats(date);
  }

  private async rollupUserStats(date: string): Promise<void> {
    // Counts from analytics_events for the day, grouped by user.
    // org_id is taken from the user's org_members row (most recent).
    // We left-join llm_calls (also for the same day, same user) so
    // token sums roll up in the same upsert.
    await this.pg.query(
      `
      with day_window as (
        select $1::date as d
      ),
      ev as (
        select
          user_id,
          count(*) filter (where event = 'memory.created')::int        as memories_created,
          count(*) filter (where event = 'memory.recalled')::int       as memories_recalled,
          count(*) filter (where event = 'memory.searched')::int       as searches,
          count(*) filter (where event = 'memory.answered')::int       as memories_answered,
          count(*) filter (where event = 'mcp.tool_invoked')::int      as mcp_tool_calls,
          count(distinct session_id) filter (where session_id is not null)::int as sessions,
          count(distinct project_id) filter (where project_id is not null)::int as projects_active
        from analytics_events, day_window
        where occurred_at >= d::timestamptz
          and occurred_at <  (d + interval '1 day')::timestamptz
          and user_id is not null
        group by user_id
      ),
      tokens as (
        select
          user_id,
          coalesce(sum(prompt_tokens), 0)::bigint     as tokens_prompt,
          coalesce(sum(completion_tokens), 0)::bigint as tokens_completion,
          count(*)::int                               as llm_calls,
          coalesce(sum(cost_usd), 0)::numeric         as llm_cost_usd
        from llm_calls, day_window
        where created_at >= d::timestamptz
          and created_at <  (d + interval '1 day')::timestamptz
          and user_id is not null
        group by user_id
      ),
      -- Episodes are project-scoped, not user-scoped. We attribute
      -- newly-synthesized episodes to the project owner so the
      -- per-user counter is non-zero for the user who triggered
      -- the synthesis pipeline. Multi-author projects will see
      -- the owner take credit; revisit when a more precise
      -- attribution is available.
      episodes as (
        select p.owner_user_id as user_id, count(*)::int as episodes_synthesized
        from episodes e
        join projects p on p.id = e.project_id
        , day_window
        where e.created_at >= d::timestamptz
          and e.created_at <  (d + interval '1 day')::timestamptz
          and p.owner_user_id is not null
        group by p.owner_user_id
      ),
      joined as (
        select coalesce(ev.user_id, tokens.user_id, episodes.user_id) as user_id,
               coalesce(ev.memories_created, 0)     as memories_created,
               coalesce(ev.memories_recalled, 0)    as memories_recalled,
               coalesce(ev.searches, 0)             as searches,
               coalesce(ev.mcp_tool_calls, 0)       as mcp_tool_calls,
               coalesce(ev.sessions, 0)             as sessions,
               coalesce(ev.projects_active, 0)      as projects_active,
               coalesce(tokens.tokens_prompt, 0)     as tokens_prompt,
               coalesce(tokens.tokens_completion, 0) as tokens_completion,
               coalesce(tokens.llm_calls, 0)         as llm_calls,
               coalesce(tokens.llm_cost_usd, 0)      as llm_cost_usd,
               coalesce(episodes.episodes_synthesized, 0) as episodes_synthesized
        from ev
        full outer join tokens   on tokens.user_id   = ev.user_id
        full outer join episodes on episodes.user_id = coalesce(ev.user_id, tokens.user_id)
      )
      insert into daily_user_stats (
        user_id, org_id, date,
        memories_created, memories_recalled, searches,
        tokens_prompt, tokens_completion,
        llm_calls, llm_cost_usd, projects_active,
        episodes_synthesized, mcp_tool_calls, sessions, updated_at
      )
      select
        j.user_id,
        (select om.org_id from org_members om where om.user_id = j.user_id order by om.joined_at asc limit 1) as org_id,
        $1::date,
        j.memories_created, j.memories_recalled, j.searches,
        j.tokens_prompt, j.tokens_completion,
        j.llm_calls, j.llm_cost_usd, j.projects_active,
        j.episodes_synthesized, j.mcp_tool_calls, j.sessions, now()
      from joined j
      where j.user_id is not null
      on conflict (user_id, date) do update set
        org_id              = excluded.org_id,
        memories_created    = excluded.memories_created,
        memories_recalled   = excluded.memories_recalled,
        searches            = excluded.searches,
        tokens_prompt       = excluded.tokens_prompt,
        tokens_completion   = excluded.tokens_completion,
        llm_calls           = excluded.llm_calls,
        llm_cost_usd        = excluded.llm_cost_usd,
        projects_active     = excluded.projects_active,
        episodes_synthesized= excluded.episodes_synthesized,
        mcp_tool_calls      = excluded.mcp_tool_calls,
        sessions            = excluded.sessions,
        updated_at          = now()
      `,
      [date],
    );
  }

  private async rollupOrgStats(date: string): Promise<void> {
    await this.pg.query(
      `
      with per_org as (
        select
          org_id,
          count(distinct user_id) filter (where memories_created + memories_recalled + searches + llm_calls > 0)::int as active_users,
          coalesce(sum(memories_created), 0)::int as memories_added,
          coalesce(sum(tokens_total), 0)::bigint  as tokens_total,
          coalesce(sum(llm_cost_usd), 0)::numeric as llm_cost_usd
        from daily_user_stats
        where date = $1::date
          and org_id is not null
        group by org_id
      ),
      eod_totals as (
        select org_id, count(*)::int as memories_total_eod
        from memories
        where archived = false
          and org_id is not null
        group by org_id
      ),
      top_users_agg as (
        select org_id,
               jsonb_agg(jsonb_build_object('user_id', user_id, 'tokens_total', tokens_total)
                         order by tokens_total desc)
               filter (where tokens_total > 0) as top_users
        from (
          select org_id, user_id, tokens_total
          from daily_user_stats
          where date = $1::date and org_id is not null
          order by tokens_total desc
          limit 100
        ) ranked
        group by org_id
      )
      insert into daily_org_stats (
        org_id, date, active_users, memories_total_eod, memories_added,
        tokens_total, llm_cost_usd, top_tags, top_users, updated_at
      )
      select
        po.org_id,
        $1::date,
        po.active_users,
        coalesce(eod.memories_total_eod, 0),
        po.memories_added,
        po.tokens_total,
        po.llm_cost_usd,
        '[]'::jsonb,
        coalesce(tua.top_users, '[]'::jsonb),
        now()
      from per_org po
      left join eod_totals eod    on eod.org_id = po.org_id
      left join top_users_agg tua on tua.org_id = po.org_id
      on conflict (org_id, date) do update set
        active_users       = excluded.active_users,
        memories_total_eod = excluded.memories_total_eod,
        memories_added     = excluded.memories_added,
        tokens_total       = excluded.tokens_total,
        llm_cost_usd       = excluded.llm_cost_usd,
        top_tags           = excluded.top_tags,
        top_users          = excluded.top_users,
        updated_at         = now()
      `,
      [date],
    );
  }
}

function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
