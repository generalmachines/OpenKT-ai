-- Personal Access Tokens for service / connector auth.
--
-- Use cases:
--   * Claude.ai or any browser-only MCP client that can't ride the
--     CLI's device-code flow. User clicks "Create token" in the
--     dashboard, pastes `okt_pat_…` into Claude.ai's MCP config.
--   * Backend / CI jobs that need to call api.openkt.ai/v1/* without
--     a human in the loop.
--   * Headless Claude Code instances where there is no `.openkt/manifest.json`.
--
-- Format mirrors GitHub: `okt_pat_<32 hex bytes>` = 72 chars. The raw
-- token is hashed (sha-256 hex) at insert time; only `token_hash` is
-- stored. The prefix (first 12 chars) is kept verbatim so the dashboard
-- can show `okt_pat_abcd…` in the list without exposing the secret.

CREATE TABLE IF NOT EXISTS "personal_access_tokens" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL,
  "name"         text NOT NULL,
  "token_hash"   text NOT NULL,
  "prefix"       text NOT NULL,
  "scopes"       text[] NOT NULL DEFAULT ARRAY['read','write']::text[],
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone,
  "expires_at"   timestamp with time zone,
  "revoked_at"   timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_tokens_token_hash_uniq"
  ON "personal_access_tokens" ("token_hash");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "personal_access_tokens_active_idx"
  ON "personal_access_tokens" ("user_id", "created_at" DESC)
  WHERE "revoked_at" IS NULL;
