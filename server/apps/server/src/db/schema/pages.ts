import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// T2 pages and T3 briefs (migration 0043, Spec 01 §3). A page lives in one
// space and never crosses spaces; each section's body cites facts as
// [^f:<uuid>]. `page_sections.embedding` (vector(1024)) and the generated
// `tsv` column exist in the database but are read and written with SQL only,
// like `memories.embedding`.
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    editedByHumanAt: timestamp("edited_by_human_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSlugUnique: unique("pages_project_slug_unique").on(t.projectId, t.slug),
    projectUpdatedIdx: index("pages_project_updated_idx").on(t.projectId, t.updatedAt),
  }),
);

export const pageSections = pgTable(
  "page_sections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pageId: uuid("page_id").notNull(),
    seq: integer("seq").notNull(),
    heading: text("heading").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    locked: boolean("locked").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pageSeqIdx: index("page_sections_page_seq_idx").on(t.pageId, t.seq),
  }),
);

export const pageSectionFacts = pgTable(
  "page_section_facts",
  {
    sectionId: uuid("section_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sectionId, t.memoryId] }),
  }),
);

export const pageRevisions = pgTable(
  "page_revisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pageId: uuid("page_id").notNull(),
    version: integer("version").notNull(),
    sectionId: uuid("section_id"),
    snapshot: jsonb("snapshot").notNull(),
    reason: text("reason").notNull().default(""),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pageVersionIdx: index("page_revisions_page_version_idx").on(t.pageId, t.version),
  }),
);

export const briefs = pgTable("briefs", {
  projectId: uuid("project_id").primaryKey(),
  briefMd: text("brief_md").notNull(),
  sourceVersionHash: text("source_version_hash"),
  writtenBy: uuid("written_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PageRow = typeof pages.$inferSelect;
export type PageSectionRow = typeof pageSections.$inferSelect;
export type PageRevisionRow = typeof pageRevisions.$inferSelect;
export type BriefRow = typeof briefs.$inferSelect;
