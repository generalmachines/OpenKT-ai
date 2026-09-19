import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Note: the legacy append-only `project_briefings` table that lived
// here was dropped in migration 0017 in favour of the live-view
// `project_briefing_cache` (see ./briefing-cache.ts). The table
// definition was removed from this file at the same time.

// Knowledge-synthesis layer.
//
// `episodes` started life as a pure clustering primitive (see migration
// 0004): a name + centroid embedding + member-count summary of a tight
// cluster of related memories. The knowledge-synthesis layer
// (migration 0014) promotes the same row into an LLM-synthesized
// knowledge node: a coherent, refreshable summary of "what is the
// current truth on this topic", refreshed every time a new related
// memory arrives.
//
// Columns added in 0014:
//   - summary         : LLM-generated narrative summary (nullable until first synthesis)
//   - tags            : denormalized tag slugs for fast topic-overlap queries
//   - confidence      : 0-1 from the synthesizer's self-rating
//   - archivedAt      : set when a "supersede" action retires the node
//   - synthesizedBy   : model id used for the last synthesis pass
//   - updatedAt       : refresh stamp (also bumped by the member-count trigger)
//
// The pre-existing columns (id, orgId, projectId, name, embedding,
// memberCount, createdAt, updatedAt) are still in the table — we mirror
// them here so the type stays in lock-step with the live shape.
export const episodes = pgTable("episodes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id"),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  summary: text("summary"),
  tags: text("tags").array(),
  confidence: real("confidence"),
  // Centroid embedding (1024d) computed by the clustering path. We keep
  // it as text here so the Drizzle types stay free of the pgvector
  // dependency — repositories cast to/from `::vector` in raw SQL.
  embedding: text("embedding"),
  memberCount: integer("member_count").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  synthesizedBy: text("synthesized_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Join table linking knowledge nodes to the raw memories that
// constitute them. `similarity_at_join` is informational; the
// synthesis layer treats membership as boolean.
export const episodeMemories = pgTable(
  "episode_memories",
  {
    episodeId: uuid("episode_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    similarityAtJoin: real("similarity_at_join"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.episodeId, t.memoryId] }),
  }),
);

export type Episode = typeof episodes.$inferSelect;
export type NewEpisode = typeof episodes.$inferInsert;
export type EpisodeMemory = typeof episodeMemories.$inferSelect;
export type NewEpisodeMemory = typeof episodeMemories.$inferInsert;
