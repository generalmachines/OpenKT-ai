import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Closed-beta waitlist. POST /v1/waitlist (public) inserts; admin
// approves via /v1/internal/waitlist/:id/approve. AuthApplicationService
// blocks signup if (email is not approved here) AND (no valid org-invite
// token) AND (user does not already exist).
export const waitlist = pgTable(
  "waitlist",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    source: text("source"),
    note: text("note"),
    useCase: text("use_case"),
    referrer: text("referrer"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    deniedReason: text("denied_reason"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    signedUpAt: timestamp("signed_up_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => ({
    emailLowerUniq: uniqueIndex("waitlist_email_lower_uniq").on(
      sql`lower(${table.email})`,
    ),
    pendingIdx: index("waitlist_pending_idx").on(table.requestedAt),
    approvedIdx: index("waitlist_approved_idx").on(table.approvedAt),
  }),
);

export type WaitlistRow = typeof waitlist.$inferSelect;
export type NewWaitlistRow = typeof waitlist.$inferInsert;
