import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Rich-payload sidecar for the data MemMachine returns when the
// synthesize stage runs. `memory_external_refs` (see ./memory-external-refs.ts)
// already stores the ONE thing the API write path needs — the
// `(memory_id, provider, external_kind)` ↔ MemMachine uid mapping for
// CRUD round-trips. But the synthesize-time response from
// `/api/v2/memories/search` ALSO carries:
//   • the canonical statement MemMachine stored for the memory
//   • semantic_memory items (one row per knowledge extraction)
//   • optional relation triples (subject / predicate / object) when
//     MemMachine's KG extractor fires
// All of which we used to throw on the floor. Each row here is one
// MemMachine node for one OpenKT memory; the synthesize stage upserts
// these whenever it runs, so the table is the "what does MemMachine
// know about this memory" projection on the OpenKT side.
//
// `node_kind` mirrors MemMachine's response taxonomy:
//   • "episodic" — episodic_memory.{long_term,short_term}.episodes[*]
//   • "semantic" — semantic_memory[*]
//   • "relation" — semantic items that parse as (s, p, o) triples
// Episodic + semantic rows always carry an `external_id`; relation rows
// may or may not, so the unique index is per (memory_id, node_kind,
// external_id) with NULLS NOT DISTINCT so duplicate-triple inserts no-op.
export const memmachineNodes = pgTable(
  "memmachine_nodes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    memoryId: uuid("memory_id").notNull(),
    provider: text("provider").notNull().default("memmachine"),
    nodeKind: text("node_kind").notNull(),
    externalId: text("external_id"),
    statement: text("statement"),
    subject: text("subject"),
    predicate: text("predicate"),
    object: text("object"),
    score: real("score"),
    externalNamespace: text("external_namespace").notNull(),
    externalProjectId: text("external_project_id").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotency: a second synthesize run for the same memory + same
    // MemMachine node (by external_id) should refresh, not duplicate.
    // Relation triples without an external_id rely on the
    // (subject, predicate, object) uniqueness instead — see triple idx.
    memoryNodeUnique: uniqueIndex("memmachine_nodes_memory_node_unique")
      .on(table.memoryId, table.nodeKind, table.externalId)
      .where(sql`${table.externalId} is not null`),
    tripleUnique: uniqueIndex("memmachine_nodes_memory_triple_unique")
      .on(table.memoryId, table.subject, table.predicate, table.object)
      .where(sql`${table.nodeKind} = 'relation' and ${table.externalId} is null`),
    memoryLookupIdx: index("memmachine_nodes_memory_kind_idx").on(
      table.memoryId,
      table.nodeKind,
    ),
    tenancyIdx: index("memmachine_nodes_tenancy_idx").on(
      table.externalNamespace,
      table.externalProjectId,
      table.nodeKind,
    ),
  }),
);

export type MemmachineNode = typeof memmachineNodes.$inferSelect;
export type NewMemmachineNode = typeof memmachineNodes.$inferInsert;
