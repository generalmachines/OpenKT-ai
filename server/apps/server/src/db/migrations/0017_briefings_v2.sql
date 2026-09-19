-- Briefings v2 — live-view model.
--
-- The old `project_briefings` table (introduced in 0014) was an
-- append-only list: every regeneration added a row. That's the wrong
-- shape for what a briefing actually is — a current snapshot of the
-- project's understanding. History is already represented by the
-- memory feed and episode lineage; briefings shouldn't duplicate it.
--
-- This migration replaces that list with:
--
--   * `project_briefing_cache` — one row per project, recomputed
--     lazily when stale. The API reads from here; the worker upserts
--     on every briefing pass.
--
-- Structured summary fields (themes / key_decisions / open_questions)
-- live as jsonb so the LLM can emit them without us iterating on
-- columns every time the schema changes.
--
-- The legacy `team_briefings` table (used by the team-surface UI under
-- /v1/briefings) is left untouched; it has a different shape, owner,
-- and consumer.

-- ── drop the append-only list ──────────────────────────────────────
DROP TABLE IF EXISTS "project_briefings";--> statement-breakpoint

-- ── single-row-per-project cache ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "project_briefing_cache" (
  "project_id" uuid PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL DEFAULT 1,
  "generated_at" timestamptz NOT NULL DEFAULT now(),
  -- When non-null and in the past, the row is considered stale and a
  -- read should enqueue a background refresh while still returning the
  -- cached value. The worker sets this to `now() + 6h` on every upsert.
  "stale_at" timestamptz NULL,
  "memory_count_at_generation" integer NOT NULL DEFAULT 0,
  "episode_count_at_generation" integer NOT NULL DEFAULT 0,
  "summary" text NOT NULL,
  -- [{name, description, memory_ids[], episode_ids[]}]
  "themes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{summary, episode_id, decided_at}]
  "key_decisions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{question, raised_in_memory_id, raised_at}]
  "open_questions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "stats" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Fast "is any briefing stale?" sweep for the worker (used by a future
-- cron that proactively refreshes briefings before users hit them).
CREATE INDEX IF NOT EXISTS "project_briefing_cache_stale_idx"
  ON "project_briefing_cache" ("stale_at")
  WHERE "stale_at" IS NOT NULL;--> statement-breakpoint

-- ── agentic_jobs.kind allowlist ────────────────────────────────────
-- 'briefing' was already in the list as of 0014, and migration 0016
-- already tightened the allowlist to swap 'pulse' for
-- 'member_knowledge_synthesis'. Re-asserting it here would clobber
-- that change, so this migration intentionally leaves the constraint
-- alone.
