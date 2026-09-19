-- Skills: a small folder of text files in the open Agent Skills format — a
-- required SKILL.md (YAML frontmatter + markdown body) plus optional extra
-- text files. Shared through `grants` like a space or a session, and
-- versioned: every save is a new immutable row in `skill_versions`.
CREATE TABLE IF NOT EXISTS "skills" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"          uuid,
  "project_id"      uuid,                     -- the space it lives in; NULL = personal to the owner
  "owner_user_id"   uuid NOT NULL,
  "slug"            text NOT NULL,            -- the frontmatter `name`
  "title"           text NOT NULL,
  "description"     text NOT NULL DEFAULT '',
  "current_version" integer NOT NULL DEFAULT 1,
  "archived"        boolean NOT NULL DEFAULT false,
  "run_count"       integer NOT NULL DEFAULT 0,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "skills_owner_slug_personal_unique"
  ON "skills" ("owner_user_id", "slug") WHERE "project_id" IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "skills_project_slug_unique"
  ON "skills" ("project_id", "slug") WHERE "project_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "skills_owner_idx" ON "skills" ("owner_user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_versions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "skill_id"    uuid NOT NULL REFERENCES "skills" ("id") ON DELETE CASCADE,
  "version"     integer NOT NULL,
  "files"       jsonb NOT NULL,               -- [{path, content}]
  "change_note" text,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "skill_versions_skill_version_unique" UNIQUE ("skill_id", "version")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_runs" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "skill_id"   uuid NOT NULL REFERENCES "skills" ("id") ON DELETE CASCADE,
  "version"    integer,
  "user_id"    uuid,
  "surface"    text,                          -- app | mcp | api
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "skill_runs_skill_created_idx"
  ON "skill_runs" ("skill_id", "created_at");--> statement-breakpoint

-- `resource_type` is text, but 0038/0039 pinned its values with CHECKs. Widen
-- both so a skill can be granted, and shared by email before sign-up.
ALTER TABLE "grants"
  DROP CONSTRAINT IF EXISTS "grants_resource_type_check";--> statement-breakpoint

ALTER TABLE "grants"
  ADD CONSTRAINT "grants_resource_type_check"
  CHECK ("resource_type" in ('org', 'project', 'session', 'skill'));--> statement-breakpoint

ALTER TABLE "pending_grants"
  DROP CONSTRAINT IF EXISTS "pending_grants_resource_type_check";--> statement-breakpoint

ALTER TABLE "pending_grants"
  ADD CONSTRAINT "pending_grants_resource_type_check"
  CHECK ("resource_type" in ('project', 'session', 'skill'));
