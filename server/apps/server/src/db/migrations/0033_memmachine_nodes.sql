-- memmachine_nodes — rich-payload sidecar for MemMachine responses.
--
-- Until 2026-05-15, the synthesize stage called MemMachine via the
-- thin worker bridge (`MemMachineBridgeService.findCandidates`) which
-- only returned (openkt_memory_id, similarity) pairs. The full
-- response — episodic uids, the canonical statement MemMachine stored,
-- semantic_memory items, optional KG triples — went on the floor.
--
-- This table is the OpenKT-side projection of "what does MemMachine
-- know about this memory":
--   • episodic rows mirror the episodic_memory.long/short_term.episodes
--     MemMachine returns, one row per uid
--   • semantic rows mirror semantic_memory[*]
--   • relation rows are subject/predicate/object triples extracted from
--     a semantic item when present
--
-- The synthesize stage upserts these whenever it runs for a memory
-- with MemMachine enabled. Best-effort — synthesize never fails if the
-- bridge errors. Re-running synthesize for the same memory should
-- refresh, not duplicate; the partial unique indexes below give us
-- that for free.
--
-- Note: `memory_external_refs` (migration 0007/0008) is unchanged and
-- still owns the single canonical (memory_id, provider, external_kind)
-- ↔ uid mapping used by the write/delete CRUD path. `memmachine_nodes`
-- is purely read-side enrichment captured at synthesize time.

CREATE TABLE IF NOT EXISTS "memmachine_nodes" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "memory_id"             uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "provider"              text NOT NULL DEFAULT 'memmachine',
  "node_kind"             text NOT NULL,
  "external_id"           text,
  "statement"             text,
  "subject"               text,
  "predicate"             text,
  "object"                text,
  "score"                 real,
  "external_namespace"    text NOT NULL,
  "external_project_id"   text NOT NULL,
  "metadata"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "recorded_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "memmachine_nodes_kind_check"
    CHECK ("node_kind" IN ('episodic','semantic','relation'))
);--> statement-breakpoint

-- Idempotency: (memory_id, node_kind, external_id) unique when external_id
-- is non-null. Lets episodic/semantic refreshes upsert cleanly while
-- letting relation rows without a uid live alongside.
CREATE UNIQUE INDEX IF NOT EXISTS "memmachine_nodes_memory_node_unique"
  ON "memmachine_nodes" ("memory_id", "node_kind", "external_id")
  WHERE "external_id" IS NOT NULL;--> statement-breakpoint

-- Relation rows without an external_id dedup by triple.
CREATE UNIQUE INDEX IF NOT EXISTS "memmachine_nodes_memory_triple_unique"
  ON "memmachine_nodes" ("memory_id", "subject", "predicate", "object")
  WHERE "node_kind" = 'relation' AND "external_id" IS NULL;--> statement-breakpoint

-- "what did MemMachine say about this memory" — used by the UI.
CREATE INDEX IF NOT EXISTS "memmachine_nodes_memory_kind_idx"
  ON "memmachine_nodes" ("memory_id", "node_kind");--> statement-breakpoint

-- Project-scoped scans, e.g. "all MemMachine semantic items in this project".
CREATE INDEX IF NOT EXISTS "memmachine_nodes_tenancy_idx"
  ON "memmachine_nodes" ("external_namespace", "external_project_id", "node_kind");
