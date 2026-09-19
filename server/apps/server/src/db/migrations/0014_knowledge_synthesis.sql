-- Knowledge-synthesis layer.
--
-- Promotes `episodes` from a pure clustering primitive (migration
-- 0004) into an LLM-synthesized knowledge node: a single row per
-- topic with a refreshable summary that represents the current
-- derived truth on that topic.
--
-- Adds:
--   * episodes.summary / tags / confidence / archived_at /
--     synthesized_by (the new node payload)
--   * `project_briefings` — the briefing-stage's append-only output
--     table, separate from the legacy `team_briefings` used by the
--     team-surface UI
--   * `synthesize` as a valid value of `agentic_jobs.kind` and
--     `agentic_jobs.stage`
--
-- Drizzle-generator caveat (mirrored from 0013): the snapshot doesn't
-- reflect every hand-trimmed intermediate migration, so this file is
-- written by hand from the schema diff. Idempotent against the
-- existing shape via IF NOT EXISTS / DROP IF EXISTS.

-- ── episodes (knowledge nodes) ─────────────────────────────────────
ALTER TABLE "episodes"
  ADD COLUMN IF NOT EXISTS "tags" text[];--> statement-breakpoint
ALTER TABLE "episodes"
  ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
ALTER TABLE "episodes"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "episodes"
  ADD COLUMN IF NOT EXISTS "synthesized_by" text;--> statement-breakpoint

-- `summary` already exists from 0004 (was nullable then; stays nullable
-- now — synthesis only populates it once the LLM has spoken). Same for
-- `updated_at` / `created_at`. No-ops on a re-run.

CREATE INDEX IF NOT EXISTS "episodes_project_active_idx"
  ON "episodes" ("project_id", "updated_at" DESC)
  WHERE "archived_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "episodes_tags_gin_idx"
  ON "episodes" USING gin ("tags")
  WHERE "tags" IS NOT NULL;--> statement-breakpoint

-- ── project_briefings ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "project_briefings" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "project_id" uuid NOT NULL,
  "content" text NOT NULL,
  "source_memory_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "synthesized_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "project_briefings_project_time_idx"
  ON "project_briefings" ("project_id", "created_at" DESC);--> statement-breakpoint

-- ── agentic_jobs: add `synthesize` to the kind/stage allowlist ─────
ALTER TABLE "agentic_jobs"
  DROP CONSTRAINT IF EXISTS "agentic_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agentic_jobs"
  ADD CONSTRAINT "agentic_jobs_kind_check"
  CHECK ("kind" in ('preprocess', 'embed', 'triage', 'episode', 'synthesize', 'pulse', 'briefing', 'answer', 'repair'));--> statement-breakpoint
