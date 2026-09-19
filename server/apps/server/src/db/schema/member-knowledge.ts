import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// member_knowledge — per-(project, user) LLM-synthesised rollup of
// "what knowledge this contributor brought to the project". Replaces
// the old `team_pulse_events` event-stream table (migration 0016
// renames it in place and reshapes it).
//
// The legacy event-stream columns (kind / actor / verb / target /
// badges / related_insight_id) are still present and nullable so
// historical rows aren't lost, but the worker no longer writes them
// — new rows carry `user_id`, `summary`, `themes`, counters, and
// `last_synthesized_at`. Upsert is keyed by (project_id, user_id).
export const memberKnowledge = pgTable(
  "member_knowledge",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    projectId: uuid("project_id").notNull(),
    // Nullable: personal projects (no org) still produce rollups.
    orgId: uuid("org_id"),
    // The contributor this row is about. Nullable only to keep legacy
    // event-stream rows valid; new rows always set it.
    userId: uuid("user_id"),
    summary: text("summary"),
    // `themes` is an array of { tag, weight, memory_count }; stored as
    // JSON so the LLM can return arbitrarily-shaped tag rollups without
    // a schema migration per change.
    themes: jsonb("themes").default(sql`'[]'::jsonb`),
    memoryCount: integer("memory_count").default(0),
    episodeCount: integer("episode_count").default(0),
    lastSynthesizedAt: timestamp("last_synthesized_at", { withTimezone: true }),
    // ── legacy event-stream columns (kept nullable for back-compat) ──
    kind: text("kind"),
    actor: text("actor"),
    actorRole: text("actor_role"),
    verb: text("verb"),
    target: text("target"),
    targetRef: text("target_ref"),
    body: text("body"),
    badges: text("badges").array().default(sql`'{}'::text[]`),
    relatedInsightId: uuid("related_insight_id"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique (project_id, user_id) for rollup rows so the worker can
    // upsert. The DB-side index is partial (WHERE user_id IS NOT NULL);
    // Drizzle's uniqueIndex helper records the columns and we rely on
    // the migration to add the partial predicate.
    projectUserUidx: uniqueIndex("member_knowledge_project_user_uidx").on(
      t.projectId,
      t.userId,
    ),
  }),
);

export type MemberKnowledgeRow = typeof memberKnowledge.$inferSelect;
export type NewMemberKnowledgeRow = typeof memberKnowledge.$inferInsert;
