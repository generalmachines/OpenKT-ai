-- Observability backend: per-LLM-call accounting + per-user quotas.
--
-- llm_calls is the canonical record of every outbound LLM call from
-- server or worker. Token counts + cost are denormalized so the
-- dashboard can compute rollups without rehydrating provider responses.
--
-- user_quotas tracks usage windows (monthly/daily/lifetime) per user
-- per provider. The free-tier MiniMax cap defaults to 1M tokens/month
-- but is env-configurable via OPENKT_MINIMAX_MONTHLY_TOKEN_CAP.

CREATE TABLE IF NOT EXISTS "llm_calls" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "project_id" uuid REFERENCES "projects"("id"),
  "user_id" uuid REFERENCES "profiles"("user_id"),
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "stage" text NOT NULL,
  "purpose" text,
  "memory_id" uuid,
  "episode_id" uuid,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer GENERATED ALWAYS AS ("prompt_tokens" + "completion_tokens") STORED,
  "cost_usd" numeric(10,6) DEFAULT 0 NOT NULL,
  "latency_ms" integer DEFAULT 0 NOT NULL,
  "status" text NOT NULL,
  "error_reason" text,
  "request_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "llm_calls_status_check" CHECK (
    "status" IN ('success', 'error', 'timeout', 'rate_limited', 'quota_exceeded')
  )
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "llm_calls_project_created_idx"
  ON "llm_calls" ("project_id", "created_at" DESC)
  WHERE "project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_user_created_idx"
  ON "llm_calls" ("user_id", "created_at" DESC)
  WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_provider_created_idx"
  ON "llm_calls" ("provider", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_stage_created_idx"
  ON "llm_calls" ("stage", "created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_quotas" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "profiles"("user_id"),
  "provider" text NOT NULL,
  "period_kind" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "tokens_used" bigint DEFAULT 0 NOT NULL,
  "tokens_limit" bigint NOT NULL,
  "cost_usd_used" numeric(10,4) DEFAULT 0 NOT NULL,
  "cost_usd_limit" numeric(10,4),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_quotas_period_kind_check" CHECK (
    "period_kind" IN ('monthly', 'daily', 'lifetime')
  ),
  CONSTRAINT "user_quotas_period_unique" UNIQUE ("user_id", "provider", "period_kind", "period_start")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "user_quotas_user_provider_idx"
  ON "user_quotas" ("user_id", "provider");--> statement-breakpoint
