-- Sign-ups and failed logins are counted separately, so a room of people
-- behind one venue address can all sign up: `failure` rows (failed login,
-- Google sign-in or password change) are limited per email and per IP over
-- 15 minutes; `signup` rows only per IP over an hour. Existing rows were all
-- counted alike and become `failure`.
ALTER TABLE "login_attempts" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'failure';--> statement-breakpoint

ALTER TABLE "login_attempts" DROP CONSTRAINT IF EXISTS "login_attempts_kind_check";--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_kind_check" CHECK ("kind" in ('failure', 'signup'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "login_attempts_ip_kind_at_idx"
  ON "login_attempts" ("ip", "kind", "at");
