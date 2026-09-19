-- Waitlist for closed beta. People submit an email + free-form note via
-- POST /v1/waitlist (public); an admin approves them, after which they
-- can sign up via Supabase Auth. AuthApplicationService.signup is the
-- gate: it short-circuits unless the email is approved here OR the
-- signup carries a valid org-invite token OR the user already exists.
--
-- approved_by holds the Supabase user UUID of the admin who approved
-- the row. Not foreign-keyed to profiles so we can keep audit history
-- after a profile soft-delete.

CREATE TABLE IF NOT EXISTS "waitlist" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"         text NOT NULL,
  "source"        text,
  "note"          text,
  "use_case"      text,
  "referrer"      text,
  "requested_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "approved_at"   timestamp with time zone,
  "approved_by"   uuid,
  "denied_at"     timestamp with time zone,
  "denied_reason" text,
  "invited_at"    timestamp with time zone,
  "signed_up_at"  timestamp with time zone,
  "metadata"      jsonb NOT NULL DEFAULT '{}'::jsonb
);--> statement-breakpoint

-- Case-insensitive unique on email. Supabase Auth lowercases emails
-- before insert, so we mirror that here — `foo@x.com` and `FOO@x.com`
-- must collapse to the same waitlist row.
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_email_lower_uniq"
  ON "waitlist" (lower("email"));--> statement-breakpoint

-- Status-prefixed index for the admin "show me pending" listing.
CREATE INDEX IF NOT EXISTS "waitlist_pending_idx"
  ON "waitlist" ("requested_at" DESC)
  WHERE "approved_at" IS NULL AND "denied_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "waitlist_approved_idx"
  ON "waitlist" ("approved_at" DESC)
  WHERE "approved_at" IS NOT NULL;
