import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Access — architecture.md §3. A grant gives a subject (today: a user;
// `team` is a future subject_type once teams exist as a first-class
// resource) a role on a resource: an org, a project ("space"), or a
// session. Facts/pages/attachments have no grants of their own — they
// inherit from their session or project, which is exactly what
// AccessScopeService resolves.
//
// resource_type/subject_type/role are kept as `text` (not pg enums) so
// a new resource type (e.g. `skill`, per the 0.2 roadmap) never forces
// a migration on this table — the zod contract enforces the allowed
// set at the application boundary, same pattern as `sessions.source`.
export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    orgId: uuid("org_id"),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    role: text("role").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    resourceSubjectUnique: unique("grants_resource_subject_unique").on(
      t.resourceType,
      t.resourceId,
      t.subjectType,
      t.subjectId,
    ),
  }),
);

export type Grant = typeof grants.$inferSelect;
export type NewGrant = typeof grants.$inferInsert;
