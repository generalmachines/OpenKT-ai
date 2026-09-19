import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { projectVisibility } from "./enums";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    orgId: uuid("org_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    visibility: projectVisibility("visibility").notNull().default("org"),
    ownerUserId: uuid("owner_user_id").notNull(),
    // Per-project secret-redaction opt-out (migration 0018). Defaults to
    // false (redaction on) so the safer behaviour is the default for every
    // existing project. The redaction layer (separate agent) reads this
    // flag on every write into memories / episodes.
    allowSecrets: boolean("allow_secrets").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgSlug: unique("projects_org_slug_unique").on(t.orgId, t.slug),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
