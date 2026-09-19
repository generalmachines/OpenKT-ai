-- Restore 'synthesize' to the agentic_jobs.kind allowlist.
-- Migration 0016 (member_knowledge rename) accidentally dropped 'synthesize'
-- when it swapped 'pulse' for 'member_knowledge_synthesis'. PR #4's
-- knowledge-synthesis stage has been silently failing on insert ever since.
--
-- This puts 'synthesize' back without disturbing the other values 0016 set.

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
    'answer',
    'repair'
  ));
