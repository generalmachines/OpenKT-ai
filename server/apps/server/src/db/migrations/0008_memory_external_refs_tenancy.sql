-- Tenancy-scoped external refs.
--
-- Why this migration:
-- The previous design had `UNIQUE (provider, external_kind, external_id)`
-- assuming MemMachine uids are forever-globally-unique. They aren't: a
-- MemMachine container or postgres-backend reset re-issues uids from 1,
-- so any new OpenKT memory whose MemMachine uid collides with a stale
-- ref hits a duplicate-key error and the write fails.
--
-- The actual invariant we care about is:
--   "this OpenKT memory has at most one external reference per
--    (provider, external_kind) — and we know which MemMachine
--    namespace + project that reference lives in."
--
-- That's modeled by:
--   - keeping (memory_id, provider, external_kind) UNIQUE
--   - dropping the global (provider, external_kind, external_id) UNIQUE
--   - adding `external_namespace` (MemMachine org_id, e.g.
--     `personal:<owner_user_id>` or `<org_id>`) and `external_project_id`
--     (MemMachine project_id, today = OpenKT project_id) so forget /
--     re-route operations don't have to re-derive the routing from
--     the joined memory row.
--   - replacing the global UNIQUE with a SCOPED UNIQUE:
--     (provider, external_kind, external_namespace, external_project_id, external_id).
--     If MemMachine resets uids inside the same namespace+project, that
--     constraint still fails — which is correct: the operator should
--     run the repair flow before the next write, not silently overwrite.

ALTER TABLE "memory_external_refs"
  ADD COLUMN IF NOT EXISTS "external_namespace" text;
--> statement-breakpoint

ALTER TABLE "memory_external_refs"
  ADD COLUMN IF NOT EXISTS "external_project_id" text;
--> statement-breakpoint

-- Backfill from the metadata JSON for existing rows (the engine has
-- been writing {org_id, project_id} into metadata since 0007).
UPDATE "memory_external_refs"
   SET "external_namespace" = coalesce(
         "external_namespace",
         "metadata"->>'org_id'
       ),
       "external_project_id" = coalesce(
         "external_project_id",
         "metadata"->>'project_id'
       )
 WHERE "external_namespace" IS NULL
    OR "external_project_id" IS NULL;
--> statement-breakpoint

-- Future writes must populate these columns.
ALTER TABLE "memory_external_refs"
  ALTER COLUMN "external_namespace" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "memory_external_refs"
  ALTER COLUMN "external_project_id" SET NOT NULL;
--> statement-breakpoint

-- Drop the over-broad global unique.
DROP INDEX IF EXISTS "memory_external_refs_provider_external_unique";
--> statement-breakpoint

-- Tenancy-scoped replacement.
CREATE UNIQUE INDEX IF NOT EXISTS
  "memory_external_refs_tenancy_external_unique"
  ON "memory_external_refs" (
    "provider", "external_kind", "external_namespace", "external_project_id", "external_id"
  );
--> statement-breakpoint

-- Lookup index for "find me the OpenKT memory_id behind this external uid
-- in this MemMachine namespace+project" — the recall hydration path.
CREATE INDEX IF NOT EXISTS
  "memory_external_refs_tenancy_lookup_idx"
  ON "memory_external_refs" (
    "provider", "external_kind", "external_namespace", "external_project_id", "external_id"
  );
