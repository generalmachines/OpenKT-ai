import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// service_health — append-only ring of probe samples written by the
// HealthMonitor cron in the worker app. 24h retention enforced by the
// same cron (it DELETEs anything older than now() - interval '24h').
//
// Why a table and not a metrics backend: the openkt platform already
// owns Postgres for everything else (analytics, audit, llm_calls). One
// row every 30s per service is ~7k rows/day total — well within what a
// single index can serve "latest per service" reads from.
export const serviceHealth = pgTable(
  "service_health",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    service: text("service").notNull(), // 'rds' | 'rabbitmq' | 'memmachine' | 'supabase' | 'openai_embed' | 'openrouter'
    status: text("status").notNull(), // 'ok' | 'degraded' | 'down'
    latencyMs: integer("latency_ms"),
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "latest row per service" — DESC on `at` lets the lookup terminate
    // after a single index seek per service.
    serviceAtIdx: index("service_health_service_at_idx").on(t.service, t.at),
  }),
);

// service_incidents — one row per state transition (ok → degraded/down).
// `resolved_at` flips when the same service returns to ok.
//
// We treat (service, severity, resolved_at IS NULL) as the natural
// "open incident" key — if a degraded service worsens to down, the
// cron resolves the old row and opens a new one so the timeline shows
// both events distinctly.
export const serviceIncidents = pgTable(
  "service_incidents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    service: text("service").notNull(),
    severity: text("severity").notNull(), // 'degraded' | 'down'
    detail: jsonb("detail"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    // Open-incident lookup — the cron's transition logic asks
    // "is there an open incident for this service?" on every tick.
    openIdx: index("service_incidents_open_idx").on(t.service, t.resolvedAt),
  }),
);

export type ServiceHealthRow = typeof serviceHealth.$inferSelect;
export type NewServiceHealthRow = typeof serviceHealth.$inferInsert;
export type ServiceIncidentRow = typeof serviceIncidents.$inferSelect;
export type NewServiceIncidentRow = typeof serviceIncidents.$inferInsert;
