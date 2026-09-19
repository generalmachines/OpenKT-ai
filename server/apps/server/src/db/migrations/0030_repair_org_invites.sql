-- HOTFIX: org_invites table was missing in staging RDS even though
-- migration 0013 was marked applied. Drizzle ran it but the ALTER
-- statements may have failed silently against a non-existent legacy
-- table, leaving the migrations row but no actual schema. This
-- migration re-applies the full target shape idempotently.
--
-- Safe on dev (table already exists), safe on prod (creates it).

CREATE TABLE IF NOT EXISTS "org_invites" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"      uuid NOT NULL,
  "invited_by"  uuid NOT NULL,
  "email"       text,
  "role"        text NOT NULL DEFAULT 'member',
  "token"       text NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by" uuid,
  "expires_at"  timestamp with time zone NOT NULL DEFAULT (now() + interval '14 days'),
  "revoked_at"  timestamp with time zone,
  "is_open"     boolean NOT NULL DEFAULT false,
  "max_uses"    integer,
  "used_count"  integer NOT NULL DEFAULT 0,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- All the columns the v2 schema needs — re-add idempotently in case
-- the table existed in a partial shape.
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "is_open" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "max_uses" integer;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "used_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- Indexes — replace the legacy unique constraint if it survived.
ALTER TABLE "org_invites"
  DROP CONSTRAINT IF EXISTS "org_invites_token_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invites_token_uniq"
  ON "org_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invites_org_token_uniq"
  ON "org_invites" USING btree ("org_id","token");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "org_invite_redemptions" (
  "invite_id"   uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "redeemed_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "org_invite_redemptions_invite_id_user_id_pk"
    PRIMARY KEY ("invite_id", "user_id")
);
