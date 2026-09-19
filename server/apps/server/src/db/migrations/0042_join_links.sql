-- Team join links: "anyone with this link can join <space> as <role>". A
-- person who opens one (signed in, or signing up on the page) gets an ordinary
-- `grants` row on the space; the link is only the way in, never a second
-- access path. `uses` counts joins; a link past `expires_at` or at `max_uses`
-- no longer works. Deleting the space deletes its links.
CREATE TABLE IF NOT EXISTS "join_links" (
  "code"       text PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "role"       text NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone,
  "max_uses"   integer,
  "uses"       integer NOT NULL DEFAULT 0,
  CONSTRAINT "join_links_role_check" CHECK ("role" in ('reader', 'editor')),
  CONSTRAINT "join_links_max_uses_check" CHECK ("max_uses" IS NULL OR "max_uses" > 0),
  CONSTRAINT "join_links_uses_check" CHECK ("uses" >= 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "join_links_project_idx"
  ON "join_links" ("project_id", "created_at");
