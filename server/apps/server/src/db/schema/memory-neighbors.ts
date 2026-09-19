import { doublePrecision, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

// memory_neighbors — pre-computed top-N pgvector neighbors per memory.
// Populated by the worker's neighbors stage after embed completes.
// Both directions are indexed so the UI can ask "who are my neighbors"
// and the pipeline can ask "who points at this memory" when a memory's
// embedding changes downstream.
export const memoryNeighbors = pgTable(
  "memory_neighbors",
  {
    memoryId: uuid("memory_id").notNull(),
    neighborMemoryId: uuid("neighbor_memory_id").notNull(),
    similarity: doublePrecision("similarity").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.memoryId, t.neighborMemoryId] }),
    lookupIdx: index("memory_neighbors_lookup_idx").on(t.memoryId, t.similarity),
    reverseIdx: index("memory_neighbors_reverse_idx").on(t.neighborMemoryId, t.similarity),
  }),
);

export type MemoryNeighbor = typeof memoryNeighbors.$inferSelect;
export type NewMemoryNeighbor = typeof memoryNeighbors.$inferInsert;
