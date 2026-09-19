ALTER TABLE "agentic_jobs"
  DROP CONSTRAINT IF EXISTS "agentic_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agentic_jobs"
  ADD CONSTRAINT "agentic_jobs_kind_check"
  CHECK ("kind" in ('preprocess', 'embed', 'triage', 'episode', 'pulse', 'briefing', 'answer', 'repair'));--> statement-breakpoint
ALTER TABLE "team_pulse_events"
  ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_pulse_events_memory_target_idx"
  ON "team_pulse_events" ("project_id", "target_ref", "kind")
  WHERE "target_ref" IS NOT NULL;
