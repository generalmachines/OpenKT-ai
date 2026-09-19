import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { projects } from "./projects";

// Team join links (migration 0042). Opening one grants the link's role on its
// space through the ordinary `grants` table; see modules/teams/.
export const joinLinks = pgTable(
  "join_links",
  {
    code: text("code").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // 'reader' | 'editor' — a link never hands out ownership.
    role: text("role").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
  },
  (t) => ({
    projectIdx: index("join_links_project_idx").on(t.projectId, t.createdAt),
  }),
);

export type JoinLink = typeof joinLinks.$inferSelect;
