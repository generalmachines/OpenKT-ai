import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// T0 (session) tier — architecture.md §2. The raw record of one
// conversation with a coding agent or chat assistant, one meeting,
// one voice note, one note. Append-only while open, then closed.
//
// NOTE on the real Postgres table name: a third-party component that
// older deployments ran against the same database created its own
// table literally named `sessions`, with a completely different shape.
// Colliding with it would silently no-op under `CREATE TABLE IF NOT
// EXISTS` and leave our columns missing. The session tables therefore
// live at the physical names `kt_sessions` / `kt_session_turns`; the
// Drizzle-level export names stay `sessions` / `sessionTurns` to match
// the product vocabulary everywhere else in the codebase.
export const sessions = pgTable("kt_sessions", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  orgId: uuid("org_id"),
  projectId: uuid("project_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  // Connector that produced the session. Kept as free text (not a pg
  // enum) so a new connector never needs a migration to be recorded —
  // mirrors how `memories.category` is handled. The application-level
  // contract still constrains the value with a zod enum on write.
  source: text("source").notNull(),
  client: text("client"),
  title: text("title"),
  summary: text("summary"),
  status: text("status").notNull().default("open"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionTurns = pgTable(
  "kt_session_turns",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    sessionId: uuid("session_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    sessionSeqUnique: unique("kt_session_turns_session_seq_unique").on(t.sessionId, t.seq),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionTurn = typeof sessionTurns.$inferSelect;
export type NewSessionTurn = typeof sessionTurns.$inferInsert;
