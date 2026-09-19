-- Deep-health monitoring tables for the OpenKT platform.
--
-- Why this exists: the existing /v1/internal/health endpoints only
-- check liveness of the server process itself. Operators need to know
-- when a downstream dependency (RDS, RabbitMQ, MemMachine, Supabase,
-- LLM providers) is unhealthy BEFORE users notice — and the platform
-- needs a structured event stream so future automation (auto-fix
-- agents, on-call routing) can subscribe to incidents.
--
-- Two tables:
--   * `service_health`    — append-only probe-sample ring (30s
--                           cadence × ~6 services × 24h retention).
--   * `service_incidents` — one row per state transition (ok →
--                           degraded/down → ok). resolved_at flips
--                           when the service recovers; an unresolved
--                           row is "currently broken".
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT
-- EXISTS) because prod RDS has had partial-application incidents and
-- we re-run migrations as a one-off ECS task.

CREATE TABLE IF NOT EXISTS "service_health" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "service"    text NOT NULL,
  "status"     text NOT NULL,
  "latency_ms" integer,
  "detail"     jsonb,
  "at"         timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- DESC on `at` so the "latest sample per service" lookup terminates
-- after a single index seek per service. The cron uses this on every
-- tick to compare last-status against current-status.
CREATE INDEX IF NOT EXISTS "service_health_service_at_idx"
  ON "service_health" ("service", "at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "service_incidents" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "service"     text NOT NULL,
  "severity"    text NOT NULL,
  "detail"      jsonb,
  "started_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone
);--> statement-breakpoint

-- Open-incident lookup: "for this service, is there an unresolved
-- row?" The cron asks this on every transition to decide whether to
-- open a new incident or update an existing one.
CREATE INDEX IF NOT EXISTS "service_incidents_open_idx"
  ON "service_incidents" ("service", "resolved_at");
