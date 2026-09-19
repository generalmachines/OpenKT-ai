import { sql } from "drizzle-orm";
import {
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Drizzle has no first-class `inet`; emit raw text from the migration
// and let the driver coerce. We keep TS typing as string | null.
const inet = customType<{ data: string }>({
  dataType() {
    return "inet";
  },
});

// analytics_events — one row per business event. Some are written by
// the middleware (HTTP-route based) and some are emit()'d explicitly
// from services for events without a 1:1 route mapping. Fire-and-forget
// — emit() catches and logs, never throws.
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    event: text("event").notNull(),
    userId: uuid("user_id"),
    orgId: uuid("org_id"),
    projectId: uuid("project_id"),
    properties: jsonb("properties").notNull().default({} as never),
    client: text("client").notNull(),
    sessionId: text("session_id"),
    requestId: text("request_id").notNull(),
    ipInet: inet("ip_inet"),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("analytics_events_user_idx").on(t.userId, t.occurredAt),
    orgIdx: index("analytics_events_org_idx").on(t.orgId, t.occurredAt),
    eventIdx: index("analytics_events_event_idx").on(t.event, t.occurredAt),
    reqIdx: index("analytics_events_req_idx").on(t.requestId),
  }),
);

export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type NewAnalyticsEvent = typeof analyticsEvents.$inferInsert;
