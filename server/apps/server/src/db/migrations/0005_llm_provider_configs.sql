CREATE TABLE IF NOT EXISTS "llm_provider_configs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "label" text DEFAULT 'default' NOT NULL,
  "base_url" text,
  "model" text,
  "api_key_ciphertext" text NOT NULL,
  "masked_api_key" text DEFAULT '****' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "llm_provider_configs_scope_type_check" CHECK ("scope_type" in ('user', 'org', 'project')),
  CONSTRAINT "llm_provider_configs_provider_check" CHECK ("provider" in ('minimax', 'openai', 'openrouter', 'custom'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_provider_configs_scope_label_unique"
  ON "llm_provider_configs" ("scope_type", "scope_id", "label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_provider_configs_resolution_idx"
  ON "llm_provider_configs" ("scope_type", "scope_id", "enabled", "updated_at" DESC);
--> statement-breakpoint
ALTER TABLE "llm_provider_configs"
  ADD COLUMN IF NOT EXISTS "masked_api_key" text DEFAULT '****' NOT NULL;
