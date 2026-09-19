-- T0 (session) tier — architecture.md §2/§4. The unit of capture: one
-- conversation with a coding agent or chat assistant, one meeting, one
-- voice note, one typed note. `kt_session_start` / `kt_session_end`
-- (MCP) and POST /v1/sessions* (REST) write here.
--
-- Table is named "kt_sessions" (not "sessions"): every environment
-- that ever ran MemMachine already owns a table literally called
-- "sessions" (MemMachine's own Alembic schema — session_key varchar
-- PK, referenced by short_term_memory_data's FK). See
-- apps/server/src/db/schema/sessions.ts for the full note. Using the
-- same name here would either no-op under IF NOT EXISTS (silently
-- missing every column this migration adds) or collide outright.
CREATE TABLE IF NOT EXISTS "kt_sessions" (
  "id"                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "org_id"            uuid,
  "project_id"        uuid NOT NULL,
  "owner_user_id"     uuid NOT NULL,
  "source"            text NOT NULL,
  "client"            text,
  "title"             text,
  "summary"           text,
  "status"            text NOT NULL DEFAULT 'open',
  "started_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at"          timestamp with time zone,
  "last_activity_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "metadata"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "kt_sessions"
  DROP CONSTRAINT IF EXISTS "kt_sessions_status_check";--> statement-breakpoint

ALTER TABLE "kt_sessions"
  ADD CONSTRAINT "kt_sessions_status_check"
  CHECK ("status" in ('open', 'closed'));--> statement-breakpoint

ALTER TABLE "kt_sessions"
  DROP CONSTRAINT IF EXISTS "kt_sessions_project_id_fkey";--> statement-breakpoint

ALTER TABLE "kt_sessions"
  ADD CONSTRAINT "kt_sessions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "kt_sessions_project_idx"
  ON "kt_sessions" ("project_id", "started_at" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "kt_sessions_owner_idx"
  ON "kt_sessions" ("owner_user_id", "started_at" DESC);--> statement-breakpoint

-- Idle-close sweep scan: find open sessions whose last_activity_at is
-- older than the idle threshold. Partial index keeps the sweep cheap
-- forever regardless of how many closed sessions accumulate.
CREATE INDEX IF NOT EXISTS "kt_sessions_open_idle_idx"
  ON "kt_sessions" ("last_activity_at")
  WHERE "status" = 'open';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kt_session_turns" (
  "id"          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "session_id"  uuid NOT NULL,
  "seq"         integer NOT NULL,
  "role"        text NOT NULL,
  "content"     text NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "metadata"    jsonb NOT NULL DEFAULT '{}'::jsonb
);--> statement-breakpoint

ALTER TABLE "kt_session_turns"
  DROP CONSTRAINT IF EXISTS "kt_session_turns_session_id_fkey";--> statement-breakpoint

ALTER TABLE "kt_session_turns"
  ADD CONSTRAINT "kt_session_turns_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "kt_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "kt_session_turns_session_seq_unique"
  ON "kt_session_turns" ("session_id", "seq");--> statement-breakpoint

-- T0→T1 provenance on memories: which session (if any) this fact was
-- saved from, and which connector produced it. Both nullable — a
-- memory created outside any session (dashboard "add memory" form,
-- pre-existing rows) keeps session_id/source null; recall treats null
-- source as "unknown/legacy".
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "session_id" uuid;--> statement-breakpoint

ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint

-- ON DELETE SET NULL (not CASCADE): a fact is immutable evidence
-- (architecture.md §2 — "sessions stay retrievable, so a weak
-- extraction loses nothing permanently") and must survive its source
-- session being deleted; it just loses the provenance pointer.
ALTER TABLE "memories"
  DROP CONSTRAINT IF EXISTS "memories_session_id_fkey";--> statement-breakpoint

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "kt_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memories_session_id_idx"
  ON "memories" ("session_id")
  WHERE "session_id" IS NOT NULL;
