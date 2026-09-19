-- Analytics events — raw event stream for pilot-team usage tracking.
--
-- Captured from a NestJS request middleware (mutating routes + an
-- allowlist of reads we care about) and from explicit service-level
-- emit() calls for business events that don't map 1:1 to an HTTP route.
-- Properties is freeform jsonb so we can extend the event shape without
-- new columns. request_id ties an event back to a single HTTP request
-- (also stamped on the x-request-id response header).

CREATE TABLE IF NOT EXISTS "analytics_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event"       text NOT NULL,
  "user_id"     uuid REFERENCES "profiles"("user_id"),
  "org_id"      uuid REFERENCES "orgs"("id"),
  "project_id"  uuid REFERENCES "projects"("id"),
  "properties"  jsonb NOT NULL DEFAULT '{}',
  "client"      text NOT NULL,
  "session_id"  text,
  "request_id"  text NOT NULL,
  "ip_inet"     inet,
  "user_agent"  text,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "analytics_events_user_idx"
  ON "analytics_events" ("user_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_org_idx"
  ON "analytics_events" ("org_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_event_idx"
  ON "analytics_events" ("event", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_req_idx"
  ON "analytics_events" ("request_id");--> statement-breakpoint
