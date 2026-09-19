-- OAuth 2.1 public-client support (token_endpoint_auth_method = "none").
--
-- Claude.ai registers as a PUBLIC client — it sends no client_secret at
-- the token endpoint and instead relies exclusively on PKCE (RFC 7636)
-- for proof-of-possession. The original 0032_oauth.sql schema made
-- `client_secret_hash` NOT NULL, which forced every registration to be
-- a confidential client and caused the token exchange to fail for
-- Claude.ai with "client_secret mismatch" when it sent no secret.
--
-- This migration:
--   1. Drops the NOT NULL constraint on `client_secret_hash` so public
--      clients can be stored without a hashed secret.
--   2. Adds a `token_endpoint_auth_method` text column (default
--      'client_secret_post' to keep existing rows compatible) that the
--      service layer reads to decide whether to require a secret at the
--      token endpoint.
--
-- Idempotent: both operations use IF NOT EXISTS / safe ALTER patterns.
-- Existing confidential clients keep their hashed secret and work
-- unchanged — the only callers of `assertClientCredentials` that skip
-- the secret check are those whose `token_endpoint_auth_method = 'none'`.

ALTER TABLE "oauth_clients"
  ALTER COLUMN "client_secret_hash" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "oauth_clients"
  ADD COLUMN IF NOT EXISTS "token_endpoint_auth_method" text NOT NULL DEFAULT 'client_secret_post';
