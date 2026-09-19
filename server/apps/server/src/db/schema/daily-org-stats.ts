import {
  bigint,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// daily_org_stats — per-(org, date) rollup, derived from daily_user_stats.
export const dailyOrgStats = pgTable(
  "daily_org_stats",
  {
    orgId: uuid("org_id").notNull(),
    date: date("date").notNull(),
    activeUsers: integer("active_users").notNull().default(0),
    memoriesTotalEod: integer("memories_total_eod").notNull().default(0),
    memoriesAdded: integer("memories_added").notNull().default(0),
    tokensTotal: bigint("tokens_total", { mode: "number" }).notNull().default(0),
    llmCostUsd: numeric("llm_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    topTags: jsonb("top_tags").notNull().default([] as never),
    topUsers: jsonb("top_users").notNull().default([] as never),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.date] }),
  }),
);

export type DailyOrgStats = typeof dailyOrgStats.$inferSelect;
export type NewDailyOrgStats = typeof dailyOrgStats.$inferInsert;
