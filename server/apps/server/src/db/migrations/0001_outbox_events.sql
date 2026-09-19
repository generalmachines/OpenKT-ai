CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb,
  "published_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claim_token" text,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_ready_idx"
  ON "outbox_events" ("published_at", "next_attempt_at", "created_at");--> statement-breakpoint
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
