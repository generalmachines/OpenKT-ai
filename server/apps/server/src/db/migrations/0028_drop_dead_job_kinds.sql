-- Drop dead 'answer' and 'repair' kinds from agentic_jobs.kind allow-list.
--
-- Both job types were stubs — the orchestrator returned
-- `{ skipped: true, reason: "not implemented yet" }` for both and no call
-- site ever published one. Removing them from the CHECK constraint lets
-- us drop the dead handler / queue / routing-key code in the same push.
--
-- Idempotent: 0024 established the pattern of fully rebuilding the
-- constraint (DROP IF EXISTS + ADD) rather than ALTER ... DROP/ADD
-- piecemeal — same approach here so re-running the migration is safe.
-- Mirrors 0026's allow-list less 'answer' and 'repair'.

ALTER TABLE "agentic_jobs"
  DROP CONSTRAINT IF EXISTS "agentic_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agentic_jobs"
  ADD CONSTRAINT "agentic_jobs_kind_check"
  CHECK ("kind" in (
    'preprocess',
    'embed',
    'triage',
    'episode',
    'synthesize',
    'member_knowledge_synthesis',
    'briefing',
    'neighbors'
  ));
