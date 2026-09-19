import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  // `inet` ships in drizzle-orm's pg-core; if you're on an older version
  // and it's missing, fall back to `customType` for the inet column.
  inet,
} from "drizzle-orm/pg-core";

// audit_log — append-only security-event ledger.
//
// The table is enforced as append-only at the DB layer via triggers
// (see migration 0019). The application layer should never call
// `db.update(auditLog)` or `db.delete(auditLog)` — both will raise.
//
// `actor_id` is nullable so we can record system-initiated events
// (e.g. a worker hard-deleting an expired memory) where there is no
// human principal. `org_id` is nullable + ON DELETE SET NULL so the
// audit trail survives an org deletion.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorId: uuid("actor_id"),
    actorKind: text("actor_kind").notNull(),
    orgId: uuid("org_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ipInet: inet("ip_inet"),
    userAgent: text("user_agent"),
    requestId: text("request_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index("audit_log_actor_idx").on(t.actorId, t.occurredAt),
    orgIdx: index("audit_log_org_idx").on(t.orgId, t.occurredAt),
    actionIdx: index("audit_log_action_idx").on(t.action, t.occurredAt),
    resourceIdx: index("audit_log_resource_idx").on(t.resourceType, t.resourceId),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

export type AuditActorKind = "user" | "service" | "api_key" | "admin" | "system";
