import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Team-level surface tables: per-project briefings. The per-member
// knowledge rollup that used to live here as `team_pulse_events` was
// renamed + reshaped in migration 0016 — see `./member-knowledge.ts`.

export const teamBriefings = pgTable("team_briefings", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  projectId: uuid("project_id").notNull(),
  // org_id is nullable because personal projects (no org) still get
  // briefings — the worker's cascade fires for every project that has
  // synthesised insights, regardless of org membership.
  orgId: uuid("org_id"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  generatedBy: uuid("generated_by"),
  briefingMd: text("briefing_md").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  sourceMemoryCountAtGeneration: integer("source_memory_count_at_generation").notNull(),
  sourceMemoryIds: uuid("source_memory_ids").array().notNull().default(sql`'{}'::uuid[]`),
  isCurrent: boolean("is_current").notNull().default(true),
});

export type TeamBriefing = typeof teamBriefings.$inferSelect;
export type NewTeamBriefing = typeof teamBriefings.$inferInsert;
