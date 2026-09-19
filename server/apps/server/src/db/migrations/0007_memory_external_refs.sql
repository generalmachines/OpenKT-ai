CREATE TABLE IF NOT EXISTS "memory_external_refs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "memory_id" uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_kind" text NOT NULL,
  "external_id" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "memory_external_refs"
  ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4();--> statement-breakpoint
UPDATE "memory_external_refs"
   SET "id" = uuid_generate_v4()
 WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "memory_external_refs"
  ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();--> statement-breakpoint
ALTER TABLE "memory_external_refs"
  ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '"memory_external_refs"'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE "memory_external_refs"
      ADD CONSTRAINT "memory_external_refs_pkey" PRIMARY KEY ("id");
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "memory_external_refs"
  ADD COLUMN IF NOT EXISTS "external_kind" text DEFAULT 'episodic' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_external_refs"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'memory_external_refs'
       AND column_name = 'external_metadata'
  ) THEN
    EXECUTE 'UPDATE "memory_external_refs"
                SET "metadata" = coalesce("metadata", "external_metadata", ''{}''::jsonb)
              WHERE "metadata" = ''{}''::jsonb';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "memory_external_refs"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_external_refs_memory_provider_kind_unique"
  ON "memory_external_refs" ("memory_id", "provider", "external_kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_external_refs_provider_external_unique"
  ON "memory_external_refs" ("provider", "external_kind", "external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_external_refs_memory_id_idx"
  ON "memory_external_refs" ("memory_id");
