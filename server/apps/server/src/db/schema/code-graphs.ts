import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const projectCodeGraphs = pgTable("project_code_graphs", {
  projectId: uuid("project_id").primaryKey(),
  graphJson: jsonb("graph_json").notNull(),
  nodeCount: integer("node_count").notNull().default(0),
  edgeCount: integer("edge_count").notNull().default(0),
  fileCount: integer("file_count").notNull().default(0),
  indexedBy: uuid("indexed_by"),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isPublic: boolean("is_public").notNull().default(false),
  shareToken: text("share_token"),
  sharedAt: timestamp("shared_at", { withTimezone: true }),
});

export type ProjectCodeGraph = typeof projectCodeGraphs.$inferSelect;
export type NewProjectCodeGraph = typeof projectCodeGraphs.$inferInsert;
