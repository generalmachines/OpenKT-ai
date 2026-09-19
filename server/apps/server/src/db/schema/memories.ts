import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { memoryKind, memoryVisibility } from "./enums";

// Memories — the core insight record. Synthesis columns
// (tier / sub_points / contributors / scores / confidence_history /
// rolls_up_memory_count) are first-class so the worker can write them
// directly without conditional column checks.
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  orgId: uuid("org_id"),
  projectId: uuid("project_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  content: text("content").notNull(),
  kind: memoryKind("kind").notNull(),
  category: varchar("category", { length: 64 }),
  visibility: memoryVisibility("visibility").notNull(),
  confidence: real("confidence").notNull(),
  importance: real("importance").notNull().default(0.5),
  decayLambda: real("decay_lambda").notNull().default(0.01),
  importanceAt: timestamp("importance_at", { withTimezone: true }).notNull().defaultNow(),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  sourceRefs: jsonb("source_refs").notNull().default(sql`'[]'::jsonb`),
  supersededBy: uuid("superseded_by"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  recallCount: integer("recall_count").notNull().default(0),
  lastRecallAt: timestamp("last_recall_at", { withTimezone: true }),
  isPinned: boolean("is_pinned").notNull().default(false),
  // T0→T1 provenance (migration 0037): which session this fact was
  // distilled from, and which connector produced that session. Both
  // nullable — memories created before sessions existed, or written
  // directly via the REST/dashboard "add memory" form with no session
  // context, keep session_id null. `source` denormalizes
  // `sessions.source` at write time so recall doesn't need a join to
  // show "from Claude Code" on every result.
  sessionId: uuid("session_id"),
  source: text("source"),
  // Verbatim evidence from the session (migration 0043, Spec 01 §5 quote
  // gate): null for facts a person saved directly. valid_from / valid_to
  // bound when the fact held; a superseded fact gets valid_to.
  quote: text("quote"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  // Synthesis columns
  tier: text("tier"), // E1 | E2 | E3 (kept text to permit nulls + future tiers)
  subPoints: text("sub_points").array().notNull().default(sql`'{}'::text[]`),
  contributors: jsonb("contributors").notNull().default(sql`'[]'::jsonb`),
  scores: jsonb("scores"),
  rollsUpMemoryCount: integer("rolls_up_memory_count").notNull().default(1),
  confidenceHistory: integer("confidence_history").array().notNull().default(sql`'{}'::integer[]`),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  orgId: uuid("org_id"),
  ownerUserId: uuid("owner_user_id"),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  useCount: integer("use_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryTags = pgTable(
  "memory_tags",
  {
    memoryId: uuid("memory_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.memoryId, t.tagId] }),
  }),
);

// Access ledger — the source of truth for who-saw-what-when. The
// recall counters on the memories table denormalize the aggregates
// for fast reads; this table keeps the long tail.
export const memoryAccesses = pgTable("memory_accesses", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  memoryId: uuid("memory_id").notNull(),
  actorUserId: uuid("actor_user_id"),
  action: text("action").notNull(), // 'read' | 'write' | 'update' | 'archive' | 'recall'
  surface: text("surface").notNull(), // 'ui' | 'api' | 'cli' | 'mcp'
  invocationId: text("invocation_id"), // groups accesses from a single MCP/CLI call
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type MemoryTag = typeof memoryTags.$inferSelect;
export type MemoryAccess = typeof memoryAccesses.$inferSelect;
export type NewMemoryAccess = typeof memoryAccesses.$inferInsert;
