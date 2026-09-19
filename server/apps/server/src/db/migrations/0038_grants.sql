-- Access — architecture.md §3. One grant table for every resource
-- type instead of a growing family of *_members tables. A resource is
-- visible to a subject if the subject owns it OR holds a grant on it
-- (directly, or — for a session — indirectly via a grant on its
-- project). AccessScopeService is the single reader of this table.
CREATE TABLE IF NOT EXISTS "grants" (
  "id"            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "org_id"        uuid,
  "resource_type" text NOT NULL,
  "resource_id"   uuid NOT NULL,
  "subject_type"  text NOT NULL,
  "subject_id"    uuid NOT NULL,
  "role"          text NOT NULL,
  "created_by"    uuid,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "grants"
  DROP CONSTRAINT IF EXISTS "grants_resource_type_check";--> statement-breakpoint

ALTER TABLE "grants"
  ADD CONSTRAINT "grants_resource_type_check"
  CHECK ("resource_type" in ('org', 'project', 'session'));--> statement-breakpoint

ALTER TABLE "grants"
  DROP CONSTRAINT IF EXISTS "grants_subject_type_check";--> statement-breakpoint

ALTER TABLE "grants"
  ADD CONSTRAINT "grants_subject_type_check"
  CHECK ("subject_type" in ('user'));--> statement-breakpoint

ALTER TABLE "grants"
  DROP CONSTRAINT IF EXISTS "grants_role_check";--> statement-breakpoint

ALTER TABLE "grants"
  ADD CONSTRAINT "grants_role_check"
  CHECK ("role" in ('reader', 'editor', 'owner'));--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "grants_resource_subject_unique"
  ON "grants" ("resource_type", "resource_id", "subject_type", "subject_id");--> statement-breakpoint

-- AccessScopeService.visibleScope's hot lookup: "every grant this
-- subject holds, across resource types, in one index scan".
CREATE INDEX IF NOT EXISTS "grants_subject_idx"
  ON "grants" ("subject_type", "subject_id", "resource_type");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "grants_resource_idx"
  ON "grants" ("resource_type", "resource_id");
