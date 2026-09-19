CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED;--> statement-breakpoint
ALTER TABLE "tags"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "team_briefings"
  ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_content_tsv"
  ON "memories" USING gin ("content_tsv")
  WHERE "archived" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_hnsw"
  ON "memories" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tags_embedding_hnsw"
  ON "tags" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tags_org_slug_unique"
  ON "tags" ("org_id", "slug")
  WHERE "org_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tags_personal_slug_unique"
  ON "tags" ("owner_user_id", "slug")
  WHERE "org_id" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "episodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "summary" text,
  "embedding" vector(1024),
  "member_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "episodes_name_check" CHECK (length("name") between 1 and 200)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_project_idx"
  ON "episodes" ("project_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_embedding_hnsw"
  ON "episodes" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "episode_memories" (
  "episode_id" uuid NOT NULL REFERENCES "episodes"("id") ON DELETE CASCADE,
  "memory_id" uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "similarity_at_join" real,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "episode_memories_episode_id_memory_id_pk" PRIMARY KEY ("episode_id", "memory_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_memories_memory_idx"
  ON "episode_memories" ("memory_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION episode_member_count_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    UPDATE episodes
       SET member_count = member_count + 1,
           updated_at = now()
     WHERE id = NEW.episode_id;
    RETURN NEW;
  ELSIF tg_op = 'DELETE' THEN
    UPDATE episodes
       SET member_count = greatest(member_count - 1, 0),
           updated_at = now()
     WHERE id = OLD.episode_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_episode_member_count_ins" ON "episode_memories";--> statement-breakpoint
CREATE TRIGGER "trg_episode_member_count_ins"
AFTER INSERT ON "episode_memories"
FOR EACH ROW
EXECUTE FUNCTION episode_member_count_sync();--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_episode_member_count_del" ON "episode_memories";--> statement-breakpoint
CREATE TRIGGER "trg_episode_member_count_del"
AFTER DELETE ON "episode_memories"
FOR EACH ROW
EXECUTE FUNCTION episode_member_count_sync();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid,
  "project_id" uuid,
  "user_id" uuid,
  "tool_name" varchar(128) NOT NULL,
  "args" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'ok' NOT NULL,
  "error_message" text,
  "duration_ms" integer,
  "session_id" varchar(128),
  "agent_identity" varchar(128),
  "invoked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_invocations_status_check" CHECK ("status" in ('ok', 'error'))
);--> statement-breakpoint
ALTER TABLE "tool_invocations"
  ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tool_invocations_project_time"
  ON "tool_invocations" ("project_id", "invoked_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tool_invocations_user_time"
  ON "tool_invocations" ("user_id", "invoked_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tool_invocations_tool_time"
  ON "tool_invocations" ("tool_name", "invoked_at" DESC);
