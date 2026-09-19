CREATE TABLE IF NOT EXISTS "device_codes" (
  "code" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "user_id" uuid,
  "session_data" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_at" timestamp with time zone,
  "consumed_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "device_codes_status_expires_idx"
  ON "device_codes" ("status", "expires_at");--> statement-breakpoint
