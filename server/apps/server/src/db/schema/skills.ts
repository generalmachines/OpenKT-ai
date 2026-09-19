import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Skills (migration 0040). A skill is a small folder of text files in the open
// Agent Skills format: a required SKILL.md plus optional extra files. The row
// here is the card (slug/title/description are re-derived from SKILL.md on
// every save); the content lives in `skill_versions`, one immutable row per
// save. Access is `grants` with resource_type = 'skill', plus the space it
// lives in (`project_id`; NULL = personal to the owner).
export interface SkillFile {
  path: string;
  content: string;
}

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id"),
    projectId: uuid("project_id"),
    ownerUserId: uuid("owner_user_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    currentVersion: integer("current_version").notNull().default(1),
    archived: boolean("archived").notNull().default(false),
    runCount: integer("run_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerSlugPersonalUnique: uniqueIndex("skills_owner_slug_personal_unique")
      .on(t.ownerUserId, t.slug)
      .where(sql`${t.projectId} is null`),
    projectSlugUnique: uniqueIndex("skills_project_slug_unique")
      .on(t.projectId, t.slug)
      .where(sql`${t.projectId} is not null`),
    ownerIdx: index("skills_owner_idx").on(t.ownerUserId),
  }),
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    files: jsonb("files").$type<SkillFile[]>().notNull(),
    changeNote: text("change_note"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    skillVersionUnique: unique("skill_versions_skill_version_unique").on(t.skillId, t.version),
  }),
);

export const skillRuns = pgTable(
  "skill_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version"),
    userId: uuid("user_id"),
    surface: text("surface"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    skillCreatedIdx: index("skill_runs_skill_created_idx").on(t.skillId, t.createdAt),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type SkillVersion = typeof skillVersions.$inferSelect;
