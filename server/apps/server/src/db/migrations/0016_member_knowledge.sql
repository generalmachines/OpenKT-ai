-- 0016_member_knowledge.sql
--
-- Rename the legacy `team_pulse_events` table (historically referred to
-- as "pulses" in product copy) to `member_knowledge` and reshape it
-- from an append-only event stream into a per-(project, user) rollup
-- of "what knowledge this contributor brought to the project". The old
-- event-stream columns are kept but made nullable so historical rows
-- aren't dropped — the worker now writes the new aggregate columns
-- instead and upserts keyed by (project_id, user_id).
--
-- Also widens the `agentic_jobs.kind` check constraint: the worker's
-- per-contributor synthesis stage publishes with `kind` set to
-- 'member_knowledge_synthesis' (replacing the old 'pulse' kind which
-- nothing else still produces).

-- ── 1. Rename table + primary key ────────────────────────────────────
ALTER TABLE IF EXISTS "team_pulse_events" RENAME TO "member_knowledge";--> statement-breakpoint
ALTER INDEX IF EXISTS "team_pulse_events_pkey" RENAME TO "member_knowledge_pkey";--> statement-breakpoint
ALTER INDEX IF EXISTS "team_pulse_events_memory_target_idx" RENAME TO "member_knowledge_memory_target_idx";--> statement-breakpoint

-- ── 2. Loosen legacy event-stream columns ────────────────────────────
-- The new rollup shape has no per-event actor / verb / target — those
-- belong to the underlying `memories` rows. We keep the columns for
-- back-fill but drop the NOT NULL constraints so the new worker can
-- insert aggregate rows.
ALTER TABLE "member_knowledge" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_knowledge" ALTER COLUMN "actor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_knowledge" ALTER COLUMN "actor_role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_knowledge" ALTER COLUMN "verb" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_knowledge" ALTER COLUMN "target" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_knowledge" ALTER COLUMN "badges" DROP NOT NULL;--> statement-breakpoint

-- ── 3. Add the new aggregate columns ─────────────────────────────────
-- profiles.user_id is the PK of the profiles table (not `id`), so the
-- FK points at profiles(user_id). ON DELETE SET NULL keeps the row
-- alive if a member is removed.
ALTER TABLE "member_knowledge"
  ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "profiles"("user_id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "member_knowledge"
  ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "member_knowledge"
  ADD COLUMN IF NOT EXISTS "themes" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "member_knowledge"
  ADD COLUMN IF NOT EXISTS "memory_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "member_knowledge"
  ADD COLUMN IF NOT EXISTS "episode_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "member_knowledge"
  ADD COLUMN IF NOT EXISTS "last_synthesized_at" timestamptz;--> statement-breakpoint

-- ── 4. Unique constraint for upsert on (project_id, user_id) ─────────
-- Partial index: only enforced for rollup rows (user_id IS NOT NULL).
-- Legacy event-stream rows with user_id = NULL are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "member_knowledge_project_user_uidx"
  ON "member_knowledge" ("project_id", "user_id")
  WHERE "user_id" IS NOT NULL;--> statement-breakpoint

-- Index for the "list contributors in a project" query.
CREATE INDEX IF NOT EXISTS "member_knowledge_project_synth_idx"
  ON "member_knowledge" ("project_id", "last_synthesized_at" DESC NULLS LAST)
  WHERE "user_id" IS NOT NULL;--> statement-breakpoint

-- ── 5. Update agentic_jobs.kind check constraint ─────────────────────
-- Replace 'pulse' with 'member_knowledge_synthesis'. Keep every other
-- existing kind exactly as it was in migration 0010. Order matters:
-- drop the old constraint first so the UPDATE can write the new value,
-- backfill legacy rows, then re-add the tightened constraint.
ALTER TABLE "agentic_jobs"
  DROP CONSTRAINT IF EXISTS "agentic_jobs_kind_check";--> statement-breakpoint
UPDATE "agentic_jobs" SET "kind" = 'member_knowledge_synthesis' WHERE "kind" = 'pulse';--> statement-breakpoint
ALTER TABLE "agentic_jobs"
  ADD CONSTRAINT "agentic_jobs_kind_check"
  CHECK ("kind" in ('preprocess', 'embed', 'triage', 'episode', 'member_knowledge_synthesis', 'briefing', 'answer', 'repair'));
