import {
  bigint,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// daily_user_stats — per-(user, date) rollup written by the worker
// rollup job. tokens_total is a Postgres GENERATED column owned by the
// migration; Drizzle treats it as readonly (omit on insert).
export const dailyUserStats = pgTable(
  "daily_user_stats",
  {
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id"),
    date: date("date").notNull(),
    memoriesCreated: integer("memories_created").notNull().default(0),
    memoriesRecalled: integer("memories_recalled").notNull().default(0),
    searches: integer("searches").notNull().default(0),
    tokensPrompt: bigint("tokens_prompt", { mode: "number" }).notNull().default(0),
    tokensCompletion: bigint("tokens_completion", { mode: "number" }).notNull().default(0),
    tokensTotal: bigint("tokens_total", { mode: "number" }),
    llmCalls: integer("llm_calls").notNull().default(0),
    llmCostUsd: numeric("llm_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    projectsActive: integer("projects_active").notNull().default(0),
    episodesSynthesized: integer("episodes_synthesized").notNull().default(0),
    mcpToolCalls: integer("mcp_tool_calls").notNull().default(0),
    sessions: integer("sessions").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.date] }),
    orgDateIdx: index("daily_user_stats_org_date_idx").on(t.orgId, t.date),
  }),
);

export type DailyUserStats = typeof dailyUserStats.$inferSelect;
export type NewDailyUserStats = typeof dailyUserStats.$inferInsert;
