ALTER TABLE "memory_accesses"
  ADD COLUMN IF NOT EXISTS "invocation_id" text;
