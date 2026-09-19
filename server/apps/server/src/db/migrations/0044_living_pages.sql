-- Living context, v0.2 (Spec 01 §3, Spec 02 §1). Additive only.
--
-- T2 pages (`pages`, `page_sections`, `page_section_facts`, `page_revisions`)
-- and T3 briefs (`briefs`), written by the result of a background job; and the
-- job queue itself (`jobs`). The server stores, shares and serves: the model
-- work of a job runs on a member's Mac, which claims the job with a 5-minute
-- lease and posts the result back; the server re-validates and applies it.
--
-- Facts gain their verbatim evidence (`quote`) and validity window.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "quote" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "valid_to" timestamp with time zone;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pages" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"          uuid NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "slug"                text NOT NULL,
  "title"               text NOT NULL,
  "summary"             text NOT NULL DEFAULT '',
  "status"              text NOT NULL DEFAULT 'active',
  "version"             integer NOT NULL DEFAULT 1,
  "edited_by_human_at"  timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pages_status_check" CHECK ("status" in ('active', 'archived')),
  CONSTRAINT "pages_project_slug_unique" UNIQUE ("project_id", "slug")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pages_project_updated_idx" ON "pages" ("project_id", "updated_at" DESC);--> statement-breakpoint

-- One section of a page: a heading and a markdown body in which every
-- sentence cites the facts it rests on as [^f:<uuid>]. `locked` = a person
-- edited it; an agent never rewrites a locked section (Spec 01 §5).
CREATE TABLE IF NOT EXISTS "page_sections" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "page_id"     uuid NOT NULL REFERENCES "pages" ("id") ON DELETE CASCADE,
  "seq"         integer NOT NULL,
  "heading"     text NOT NULL,
  "body_md"     text NOT NULL DEFAULT '',
  "embedding"   vector(1024),
  "tsv"         tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("heading", '') || ' ' || coalesce("body_md", ''))) STORED,
  "locked"      boolean NOT NULL DEFAULT false,
  "version"     integer NOT NULL DEFAULT 1,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "page_sections_page_seq_idx" ON "page_sections" ("page_id", "seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_sections_tsv_idx" ON "page_sections" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_sections_embedding_hnsw" ON "page_sections" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

-- Which facts a section cites. Deleting a fact drops the link; the body keeps
-- its text until the section is next written.
CREATE TABLE IF NOT EXISTS "page_section_facts" (
  "section_id"  uuid NOT NULL REFERENCES "page_sections" ("id") ON DELETE CASCADE,
  "memory_id"   uuid NOT NULL REFERENCES "memories" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("section_id", "memory_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "page_section_facts_memory_idx" ON "page_section_facts" ("memory_id");--> statement-breakpoint

-- Every page change writes one row: the whole page as it was after the change.
-- actor = 'agent:write_section' | 'user:<uuid>'.
CREATE TABLE IF NOT EXISTS "page_revisions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "page_id"     uuid NOT NULL REFERENCES "pages" ("id") ON DELETE CASCADE,
  "version"     integer NOT NULL,
  "section_id"  uuid,
  "snapshot"    jsonb NOT NULL,
  "reason"      text NOT NULL DEFAULT '',
  "actor"       text NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "page_revisions_page_version_idx" ON "page_revisions" ("page_id", "version" DESC);--> statement-breakpoint

-- T3: one brief per space, regenerated from the page summaries.
CREATE TABLE IF NOT EXISTS "briefs" (
  "project_id"           uuid PRIMARY KEY REFERENCES "projects" ("id") ON DELETE CASCADE,
  "brief_md"             text NOT NULL,
  "source_version_hash"  text,
  "written_by"           uuid,
  "updated_at"           timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Background work. A job is claimed by a member's Mac (claimed_by = that
-- member, who must be an editor or owner of the job's space) with a lease;
-- an expired lease makes it claimable again. `dedupe_key` is unique among
-- live jobs only, so a debounced kind (refresh_brief) can run again later.
CREATE TABLE IF NOT EXISTS "jobs" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"         text NOT NULL,
  "project_id"   uuid REFERENCES "projects" ("id") ON DELETE CASCADE,
  "session_id"   uuid REFERENCES "kt_sessions" ("id") ON DELETE CASCADE,
  "payload"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"       text NOT NULL DEFAULT 'queued',
  "claimed_by"   uuid,
  "claimed_at"   timestamp with time zone,
  "lease_until"  timestamp with time zone,
  "attempts"     integer NOT NULL DEFAULT 0,
  "run_after"    timestamp with time zone NOT NULL DEFAULT now(),
  "result"       jsonb,
  "error"        text,
  "dedupe_key"   text,
  "finished_at"  timestamp with time zone,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "jobs_status_check" CHECK ("status" in ('queued', 'claimed', 'done', 'failed'))
);--> statement-breakpoint

-- A table of the same name left by something else would make IF NOT EXISTS a
-- silent no-op; stop the release instead.
DO $$
DECLARE
  expected text[][] := ARRAY[
    ARRAY['jobs', 'lease_until'],
    ARRAY['pages', 'edited_by_human_at'],
    ARRAY['page_sections', 'locked'],
    ARRAY['page_revisions', 'actor'],
    ARRAY['briefs', 'source_version_hash']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(expected, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = expected[i][1] AND column_name = expected[i][2]
    ) THEN
      RAISE EXCEPTION 'a table named % already exists with another shape', expected[i][1];
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "jobs_claim_idx" ON "jobs" ("status", "run_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_project_idx" ON "jobs" ("project_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_session_idx" ON "jobs" ("session_id") WHERE "session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_live_unique"
  ON "jobs" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL AND "status" in ('queued', 'claimed');
