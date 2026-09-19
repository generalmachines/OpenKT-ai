-- Daily per-org stat rollup — derived from daily_user_stats by the
-- worker rollup job. Powers the org analytics page.

CREATE TABLE IF NOT EXISTS "daily_org_stats" (
  "org_id"             uuid NOT NULL REFERENCES "orgs"("id"),
  "date"               date NOT NULL,
  "active_users"       integer NOT NULL DEFAULT 0,
  "memories_total_eod" integer NOT NULL DEFAULT 0,
  "memories_added"     integer NOT NULL DEFAULT 0,
  "tokens_total"       bigint  NOT NULL DEFAULT 0,
  "llm_cost_usd"       numeric(10,6) NOT NULL DEFAULT 0,
  "top_tags"           jsonb NOT NULL DEFAULT '[]',
  "top_users"          jsonb NOT NULL DEFAULT '[]',
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "date")
);--> statement-breakpoint
