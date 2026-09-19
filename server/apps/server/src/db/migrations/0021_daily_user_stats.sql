-- Daily per-user stat rollup — written by the worker rollup job.
--
-- One row per (user, date). Source of truth for the /v1/analytics/me
-- and per-org user-breakdown surfaces. The rollup is idempotent — the
-- worker can re-run any UTC day to overwrite. tokens_total is a Postgres
-- GENERATED column so dashboards never have to add prompt+completion in
-- application code.

CREATE TABLE IF NOT EXISTS "daily_user_stats" (
  "user_id"              uuid NOT NULL REFERENCES "profiles"("user_id"),
  "org_id"               uuid REFERENCES "orgs"("id"),
  "date"                 date NOT NULL,
  "memories_created"     integer NOT NULL DEFAULT 0,
  "memories_recalled"    integer NOT NULL DEFAULT 0,
  "searches"             integer NOT NULL DEFAULT 0,
  "tokens_prompt"        bigint  NOT NULL DEFAULT 0,
  "tokens_completion"    bigint  NOT NULL DEFAULT 0,
  "tokens_total"         bigint  GENERATED ALWAYS AS ("tokens_prompt" + "tokens_completion") STORED,
  "llm_calls"            integer NOT NULL DEFAULT 0,
  "llm_cost_usd"         numeric(10,6) NOT NULL DEFAULT 0,
  "projects_active"      integer NOT NULL DEFAULT 0,
  "episodes_synthesized" integer NOT NULL DEFAULT 0,
  "mcp_tool_calls"       integer NOT NULL DEFAULT 0,
  "sessions"             integer NOT NULL DEFAULT 0,
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "date")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "daily_user_stats_org_date_idx"
  ON "daily_user_stats" ("org_id", "date" DESC);--> statement-breakpoint
