import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Background work (migration 0043, Spec 01 §3 `jobs`). The model work runs on
// a member's Mac: the Mac claims a job with a lease (`claimed_by`,
// `lease_until`), runs it with a local model and posts the result, which the
// server re-validates and applies. Status: queued → claimed → done | failed.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: text("kind").notNull(),
    projectId: uuid("project_id"),
    sessionId: uuid("session_id"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"),
    claimedBy: uuid("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    result: jsonb("result"),
    error: text("error"),
    dedupeKey: text("dedupe_key"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    claimIdx: index("jobs_claim_idx").on(t.status, t.runAfter),
    projectIdx: index("jobs_project_idx").on(t.projectId, t.createdAt),
  }),
);

export type JobRow = typeof jobs.$inferSelect;
