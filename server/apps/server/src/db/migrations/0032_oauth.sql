-- OAuth 2.1 + RFC 7591 Dynamic Client Registration for the MCP server.
--
-- Why this exists: Claude.ai's "Add custom MCP" form has OAuth Client ID
-- and Client Secret fields — it does NOT accept a static `Authorization:
-- Bearer …` header the way Claude Code / Cursor / VS Code / Codex do.
-- The connector flow we shipped in migration 0031 + /v1/me/connectors
-- covers the bearer-header crowd; this migration unblocks the browser
-- crowd by making OpenKT a full OAuth provider that supports DCR so the
-- user only ever pastes one thing: the URL.
--
-- Three new pieces:
--   * `oauth_clients`        — registered relying parties (one per
--                              browser connector install, minted on the
--                              fly via POST /oauth/register)
--   * `oauth_authorization_codes`
--                            — short-lived PKCE codes exchanged for
--                              access + refresh tokens at /oauth/token
--   * extra columns on `personal_access_tokens` to track which OAuth
--     client an access/refresh token belongs to. Reusing the PAT table
--     means the BearerAuthGuard's existing `okt_pat_…` verify path
--     covers OAuth-issued tokens with zero code changes — clients
--     present the access token as `Authorization: Bearer okt_pat_…`
--     and the MCP server resolves it the same as a manual PAT.

CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "client_id"          text PRIMARY KEY,
  "client_secret_hash" text NOT NULL,
  "name"               text NOT NULL,
  "redirect_uris"      text[] NOT NULL,
  "created_by"         uuid,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at"         timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oauth_clients_active_idx"
  ON "oauth_clients" ("created_at" DESC)
  WHERE "revoked_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
  "code"                  text PRIMARY KEY,
  "client_id"             text NOT NULL,
  "user_id"               uuid NOT NULL,
  "redirect_uri"          text NOT NULL,
  "code_challenge"        text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "scopes"                text[] NOT NULL DEFAULT ARRAY['read','write']::text[],
  "expires_at"            timestamp with time zone NOT NULL DEFAULT (now() + interval '10 minutes'),
  "used_at"               timestamp with time zone,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_client_idx"
  ON "oauth_authorization_codes" ("client_id");--> statement-breakpoint

-- Extend personal_access_tokens so OAuth-issued tokens can coexist with
-- manually-minted PATs in the same table. `oauth_client_id IS NULL`
-- distinguishes a hand-rolled PAT from one issued by an OAuth grant;
-- `refresh_token_hash` is only populated for OAuth-issued tokens (sha256
-- hex of the `okt_rt_…` raw refresh token).
ALTER TABLE "personal_access_tokens"
  ADD COLUMN IF NOT EXISTS "oauth_client_id"      text,
  ADD COLUMN IF NOT EXISTS "refresh_token_hash"   text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_tokens_refresh_token_hash_uniq"
  ON "personal_access_tokens" ("refresh_token_hash")
  WHERE "refresh_token_hash" IS NOT NULL;
