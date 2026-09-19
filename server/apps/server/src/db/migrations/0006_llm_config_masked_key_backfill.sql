ALTER TABLE "llm_provider_configs"
  ADD COLUMN IF NOT EXISTS "masked_api_key" text DEFAULT '****' NOT NULL;
