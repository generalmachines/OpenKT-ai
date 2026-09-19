-- Cleanup of legacy memory_external_refs columns + indexes.
--
-- 0007 created the table with PK (memory_id, provider, external_id),
-- a separate `id uuid` column added late as a nullable-with-default,
-- and an `external_metadata` jsonb that the engine never reads or
-- writes. 0008 added the tenancy columns + the correct unique index
-- but couldn't drop the 0007 leftovers without a separate migration
-- (Drizzle doesn't model the historical PK rename cleanly).
--
-- This migration brings the table to its final shape:
--   - PK on `id` (the uuid column)
--   - drop the legacy compound PK
--   - drop the now-redundant `(provider, external_id)` index — the
--     tenancy lookup index covers all real query patterns
--   - drop `external_metadata` jsonb (dead since 0007; the live
--     metadata column is `metadata`)
--
-- All migrations are forward-only. If you need to roll back, restore
-- from a base backup of the database.

-- 1) Move the primary key to `id`.
ALTER TABLE "memory_external_refs"
  DROP CONSTRAINT IF EXISTS "memory_external_refs_pkey";
--> statement-breakpoint

ALTER TABLE "memory_external_refs"
  ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "memory_external_refs"
  ADD CONSTRAINT "memory_external_refs_pkey" PRIMARY KEY ("id");
--> statement-breakpoint

-- 2) Drop the redundant 0007 lookup index. The tenancy_lookup_idx
--    from 0008 is what every live query uses now.
DROP INDEX IF EXISTS "memory_external_refs_lookup_idx";
--> statement-breakpoint

-- 3) Drop the dead 0007 jsonb column. The live one is `metadata`.
ALTER TABLE "memory_external_refs"
  DROP COLUMN IF EXISTS "external_metadata";
