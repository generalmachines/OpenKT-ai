-- Built-in accounts: the server owns sign-up and sign-in, so a deployment
-- needs no third-party auth service. A successful sign-in mints an ordinary
-- access token (personal_access_tokens, name `session:<client>`), so there is
-- no session table here — only the credentials that prove who you are.
CREATE TABLE IF NOT EXISTS "user_credentials" (
  "user_id"        uuid PRIMARY KEY REFERENCES "profiles" ("user_id") ON DELETE CASCADE,
  "email"          text NOT NULL,            -- stored lower-cased
  "password_hash"  text,                     -- scrypt$N$r$p$<salt b64>$<hash b64>; NULL = Google-only account
  "google_sub"     text,
  "email_verified" boolean NOT NULL DEFAULT false,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "last_login_at"  timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "user_credentials_email_unique"
  ON "user_credentials" ("email");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "user_credentials_google_sub_unique"
  ON "user_credentials" ("google_sub");--> statement-breakpoint

-- One row per counted sign-in attempt. The limiter counts rows in the last
-- 15 minutes per email and per IP; rows older than a day are swept by the app.
CREATE TABLE IF NOT EXISTS "login_attempts" (
  "email" text,
  "ip"    text,
  "at"    timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "login_attempts_email_at_idx"
  ON "login_attempts" ("email", "at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "login_attempts_ip_at_idx"
  ON "login_attempts" ("ip", "at");--> statement-breakpoint

-- Share by email with someone who has no account yet. Converted into a real
-- `grants` row when that email signs up (or first signs in with Google).
CREATE TABLE IF NOT EXISTS "pending_grants" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resource_type" text NOT NULL,
  "resource_id"   uuid NOT NULL,
  "email"         text NOT NULL,             -- stored lower-cased
  "role"          text NOT NULL,
  "created_by"    uuid,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pending_grants_resource_type_check" CHECK ("resource_type" in ('project', 'session')),
  CONSTRAINT "pending_grants_role_check" CHECK ("role" in ('reader', 'editor', 'owner'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "pending_grants_resource_email_unique"
  ON "pending_grants" ("resource_type", "resource_id", "email");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pending_grants_email_idx"
  ON "pending_grants" ("email");
