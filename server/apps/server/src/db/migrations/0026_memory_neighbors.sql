-- Semantic neighbors pre-compute stage.
--
-- `memory_neighbors` stores the top-N pgvector cosine-similarity matches
-- for each memory inside its project. The worker's neighbors stage
-- (new in this migration) runs after embed and populates this table so
-- the UI can render a "related memories" panel without paying for an
-- on-demand pgvector top-K query on every memory open.
--
-- Both lookup directions are indexed: `(memory_id, similarity DESC)`
-- for "who are my neighbors" and `(neighbor_memory_id, similarity DESC)`
-- for "who points at me" (used to invalidate when a memory's vector
-- changes downstream).
--
-- The `agentic_jobs.kind` allow-list gains `'neighbors'` so the worker's
-- job ledger row can persist when this stage runs. Migrations 0016 and
-- 0024 established the pattern of rebuilding this constraint instead of
-- ALTER ... DROP / ADD piecemeal — same approach here.

CREATE TABLE IF NOT EXISTS "memory_neighbors" (
  "memory_id"           uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "neighbor_memory_id"  uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "similarity"          double precision NOT NULL CHECK ("similarity" >= 0 AND "similarity" <= 1),
  "computed_at"         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("memory_id", "neighbor_memory_id"),
  CONSTRAINT "memory_neighbors_no_self" CHECK ("memory_id" <> "neighbor_memory_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_neighbors_lookup_idx"
  ON "memory_neighbors" ("memory_id", "similarity" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_neighbors_reverse_idx"
  ON "memory_neighbors" ("neighbor_memory_id", "similarity" DESC);--> statement-breakpoint

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
    'repair',
    'neighbors'
  ));
