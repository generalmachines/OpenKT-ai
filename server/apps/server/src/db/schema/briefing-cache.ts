import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Briefings v2 — live-view model.
//
// One row per project. The worker UPSERTs on every briefing pass and
// bumps `version`. Reads are by primary key (`project_id`); when the
// API sees `stale_at < now()` it enqueues a background refresh and
// still returns the cached row with `stale: true` on the wire so the
// UI never blocks.
//
// History of the project's knowledge is represented by the memory
// feed + episode lineage. The briefing table deliberately does *not*
// keep a history of past summaries; the changelog endpoint
// (`/v1/projects/:project_id/changelog?since=...`) is where
// "what happened between t1 and t2" lives.
export const projectBriefingCache = pgTable("project_briefing_cache", {
  projectId: uuid("project_id").primaryKey(),
  version: integer("version").notNull().default(1),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  // When non-null and in the past, the row is stale — the API enqueues
  // a refresh job and tags the response with `stale: true`.
  staleAt: timestamp("stale_at", { withTimezone: true }),
  memoryCountAtGeneration: integer("memory_count_at_generation").notNull().default(0),
  episodeCountAtGeneration: integer("episode_count_at_generation").notNull().default(0),
  summary: text("summary").notNull(),
  // [{name, description, memory_ids[], episode_ids[]}]
  themes: jsonb("themes").notNull().default(sql`'[]'::jsonb`),
  // [{summary, episode_id, decided_at}]
  keyDecisions: jsonb("key_decisions").notNull().default(sql`'[]'::jsonb`),
  // [{question, raised_in_memory_id, raised_at}]
  openQuestions: jsonb("open_questions").notNull().default(sql`'[]'::jsonb`),
  stats: jsonb("stats").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectBriefingCache = typeof projectBriefingCache.$inferSelect;
export type NewProjectBriefingCache = typeof projectBriefingCache.$inferInsert;
