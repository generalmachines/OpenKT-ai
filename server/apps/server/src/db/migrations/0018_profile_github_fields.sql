-- GitHub OAuth metadata + per-project secret-redaction opt-out.
--
-- Supabase now handles a GitHub OAuth provider for the `uewutpfgxjilpgzzgtdc`
-- project. When a user signs in through GitHub, Supabase populates the JWT's
-- `user_metadata` with `{ user_name, avatar_url, full_name, provider_id, ... }`
-- and `app_metadata.provider = 'github'`. The BFF lazy-creates the
-- corresponding `profiles` row on first authenticated request (the old
-- `on_auth_user_created` trigger that lived in Supabase's `public` schema
-- was dropped in the 2026-05-12 Supabase cleanup, so the BFF is now the
-- single insertion point).
--
-- This migration adds the columns the lazy-create needs to land, plus a
-- per-project `allow_secrets` opt-out flag for the upcoming redaction layer
-- (kept here because it's a small additive column that the github-auth
-- agent owns end-to-end — the redaction agent will read it).

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "github_username" text,
  ADD COLUMN IF NOT EXISTS "github_id" text,
  ADD COLUMN IF NOT EXISTS "avatar_url" text,
  ADD COLUMN IF NOT EXISTS "auth_provider" text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS "bio" text,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint

-- Unique on github_id (when present) — one Supabase auth user per GitHub
-- account. Added as a constraint rather than inlined into the ADD COLUMN
-- so backfills against existing email-only profiles (NULL github_id) keep
-- working under `IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_github_id_key'
  ) THEN
    ALTER TABLE "profiles" ADD CONSTRAINT "profiles_github_id_key" UNIQUE ("github_id");
  END IF;
END$$;--> statement-breakpoint

-- Partial index for the "look up profile by GitHub login" path. Skips NULLs
-- so legacy email-only rows don't pollute the index.
CREATE INDEX IF NOT EXISTS "profiles_github_username_idx"
  ON "profiles" ("github_username")
  WHERE "github_username" IS NOT NULL;--> statement-breakpoint

-- Per-project secret-redaction opt-out for the upcoming redaction layer.
-- Defaults to false (redaction on) so the safer behaviour is the default
-- for every existing project. Toggled per-project from the dashboard.
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "allow_secrets" boolean NOT NULL DEFAULT false;
