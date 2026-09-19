-- Record the actual asynchronous queue backend used by worker jobs.
--
-- Existing rows keep their historical source. New and retried jobs explicitly
-- write either "rabbitmq" or "sqs" from OPENKT_QUEUE_BACKEND.

ALTER TABLE "agentic_jobs"
  DROP CONSTRAINT IF EXISTS "agentic_jobs_source_check";--> statement-breakpoint

ALTER TABLE "agentic_jobs"
  ADD CONSTRAINT "agentic_jobs_source_check"
  CHECK ("source" in ('legacy', 'rabbitmq', 'sqs'));
