-- Targeted + open-link org invites with RBAC.
--
-- Replaces the legacy `org_invites` table from the initial baseline,
-- which only supported single-use targeted invites. The new shape:
--   * `email` now nullable (open invites don't target an inbox).
--   * `invited_by` now NOT NULL (always known — the actor that issued it).
--   * `expires_at` is required.
--   * `revoked_at` + `is_open` + `max_uses` + `used_count` for open / link-share.
--   * `org_invite_redemptions` tracks individual users that redeemed an
--     open invite (the targeted path still uses `accepted_at` / `accepted_by`).
--
-- Drizzle generator caveat: this file is hand-trimmed because the
-- baseline + intermediate SQL migrations were not reflected in the
-- snapshot, so an unsupervised `drizzle-kit generate` over-collects.
-- Idempotent against the legacy shape via IF NOT EXISTS / DROP IF EXISTS.

-- Ensure the legacy `org_invites` shape exists before we ALTER it.
-- Prod had this table from the original Supabase schema we migrated
-- from; fresh local DBs never created it. CREATE TABLE IF NOT EXISTS
-- is a no-op when the table already exists (prod, staging) and bootstraps
-- it when the baseline never had it (fresh dev DBs).
CREATE TABLE IF NOT EXISTS "org_invites" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"      uuid NOT NULL,
  "invited_by"  uuid,
  "email"       text NOT NULL,
  "role"        text NOT NULL DEFAULT 'member',
  "token"       text NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by" uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "org_invites_token_unique" UNIQUE ("token")
);--> statement-breakpoint

-- The legacy `org_invites` has rows in prod with the old shape. Drop
-- the legacy unique constraint (Drizzle named it `org_invites_token_unique`)
-- and rebuild as a uniqueIndex.
ALTER TABLE "org_invites" DROP CONSTRAINT IF EXISTS "org_invites_token_unique";--> statement-breakpoint

ALTER TABLE "org_invites" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint

-- `invited_by` was nullable in the legacy shape; backfill from `created_by`
-- of the owning org for any orphan rows, then enforce NOT NULL.
UPDATE "org_invites" AS i
   SET "invited_by" = o."created_by"
  FROM "orgs" o
 WHERE i."invited_by" IS NULL
   AND o.id = i."org_id"
   AND o."created_by" IS NOT NULL;--> statement-breakpoint

-- Hard-fail if any orphans remain — better to surface than to silently drop.
ALTER TABLE "org_invites" ALTER COLUMN "invited_by" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint

-- Backfill expires_at for any rows that pre-date this migration. 14 days
-- past `created_at` is generous; revoked rows are irrelevant either way.
UPDATE "org_invites"
   SET "expires_at" = COALESCE("expires_at", "created_at" + interval '14 days')
 WHERE "expires_at" IS NULL;--> statement-breakpoint

ALTER TABLE "org_invites" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "is_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "max_uses" integer;--> statement-breakpoint
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "used_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "org_invites_token_uniq"
  ON "org_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invites_org_token_uniq"
  ON "org_invites" USING btree ("org_id","token");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "org_invite_redemptions" (
  "invite_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_invite_redemptions_invite_id_user_id_pk"
    PRIMARY KEY ("invite_id", "user_id")
);--> statement-breakpoint
