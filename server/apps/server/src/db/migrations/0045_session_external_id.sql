-- Spec 04: `POST /v1/sessions` with the same `(source, external_id)` for the
-- same owner returns the existing session instead of making a duplicate, so a
-- hook or an import that retries is safe. `external_url` links back to the
-- conversation in the tool it came from. Additive; existing rows keep NULL
-- (no external id, never deduplicated).
ALTER TABLE "kt_sessions" ADD COLUMN IF NOT EXISTS "external_id" text;--> statement-breakpoint
ALTER TABLE "kt_sessions" ADD COLUMN IF NOT EXISTS "external_url" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "kt_sessions_owner_source_external_unique"
  ON "kt_sessions" ("owner_user_id", "source", "external_id")
  WHERE "external_id" IS NOT NULL;
