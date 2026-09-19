CREATE TABLE IF NOT EXISTS "agentic_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_key" text NOT NULL,
  "kind" text NOT NULL,
  "stage" text,
  "source" text DEFAULT 'rabbitmq' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now(),
  "error" text,
  "last_error_at" timestamp with time zone,
  "result" jsonb,
  "correlation_id" uuid,
  "causation_id" uuid,
  "project_id" uuid,
  "org_id" uuid,
  "user_id" uuid NOT NULL,
  "memory_id" uuid,
  "version_token" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agentic_jobs_job_key_unique" UNIQUE ("job_key"),
  CONSTRAINT "agentic_jobs_kind_check" CHECK ("kind" in ('preprocess', 'embed', 'triage', 'episode', 'briefing', 'answer', 'repair')),
  CONSTRAINT "agentic_jobs_source_check" CHECK ("source" in ('legacy', 'rabbitmq')),
  CONSTRAINT "agentic_jobs_status_check" CHECK ("status" in ('pending', 'running', 'done', 'failed', 'cancelled'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agentic_jobs_stage_idx"
  ON "agentic_jobs" ("stage", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agentic_jobs_memory_stage_idx"
  ON "agentic_jobs" ("memory_id", "stage", "created_at" DESC)
  WHERE "memory_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agentic_jobs_correlation_idx"
  ON "agentic_jobs" ("correlation_id")
  WHERE "correlation_id" IS NOT NULL;
