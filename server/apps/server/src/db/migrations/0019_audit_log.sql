-- Audit log — append-only record of every security-sensitive action.
--
-- The table is enforced append-only at the database level via two
-- BEFORE UPDATE / BEFORE DELETE triggers that raise. That way even a
-- bug in the application layer (or a superuser running ad-hoc SQL via
-- the app role) cannot rewrite history; the only way to mutate this
-- table is to drop the trigger first, which would be visible in any
-- migration diff.
--
-- Writes happen synchronously alongside the action they describe — the
-- service throws on insert failure, and the caller is expected to let
-- the surrounding transaction roll back. Integrity > availability for
-- security-relevant trails.

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" uuid REFERENCES "profiles"("user_id"),
  "actor_kind" text NOT NULL,
  "org_id" uuid REFERENCES "orgs"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "before" jsonb,
  "after" jsonb,
  "ip_inet" inet,
  "user_agent" text,
  "request_id" text NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_log_actor_kind_check" CHECK (
    "actor_kind" IN ('user', 'service', 'api_key', 'admin', 'system')
  )
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_log_actor_idx"
  ON "audit_log" ("actor_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_org_idx"
  ON "audit_log" ("org_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx"
  ON "audit_log" ("action", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_resource_idx"
  ON "audit_log" ("resource_type", "resource_id");--> statement-breakpoint

-- Immutability enforcement — raise on any UPDATE / DELETE attempt.
CREATE OR REPLACE FUNCTION "audit_log_immutable"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — % not allowed', TG_OP;
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update" BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_immutable"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_no_delete" BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_immutable"();--> statement-breakpoint
