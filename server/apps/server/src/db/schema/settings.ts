import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Three scope buckets for settings: per-user, per-project, per-org.
// Each row is a flat JSONB blob the application service decides how
// to shape — keeps the schema stable when individual settings keys
// come and go.

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id").primaryKey(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectSettings = pgTable("project_settings", {
  projectId: uuid("project_id").primaryKey(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgSettings = pgTable("org_settings", {
  orgId: uuid("org_id").primaryKey(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// `orgInvites` moved to ./org-invites.ts to add targeted + open-link
// modes (expires_at, is_open, max_uses, used_count, revoked_at) and
// a sibling `org_invite_redemptions` table. Importers should pull
// from the barrel (./index.ts).

export const projectInvites = pgTable("project_invites", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  projectId: uuid("project_id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  token: text("token").notNull().unique(),
  invitedBy: uuid("invited_by"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembers = pgTable("project_members", {
  projectId: uuid("project_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull().default("member"),
  invitedBy: uuid("invited_by"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;
export type ProjectSettings = typeof projectSettings.$inferSelect;
export type OrgSettings = typeof orgSettings.$inferSelect;
export type ProjectInvite = typeof projectInvites.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
