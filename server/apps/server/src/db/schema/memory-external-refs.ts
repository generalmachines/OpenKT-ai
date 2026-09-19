import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Tenancy-scoped external memory engine references.
//
// Each row links one OpenKT memory to its representation in a single
// (provider, external_kind) slot of an external engine. The
// `external_namespace` + `external_project_id` columns store the
// engine-side routing so we can perform CRUD without re-deriving from
// the joined memory row, and so the unique constraint is scoped to
// (provider, kind, namespace, project, external_id) — uids that
// MemMachine reuses after a state reset don't collide with refs from
// a different OpenKT user/org.
export const memoryExternalRefs = pgTable(
  "memory_external_refs",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    memoryId: uuid("memory_id").notNull(),
    provider: text("provider").notNull(),
    externalKind: text("external_kind").notNull(),
    externalId: text("external_id").notNull(),
    // MemMachine `org_id`. Today: `personal:<owner_user_id>` for
    // personal-scope memories, `<openkt_org_id>` for org-scope.
    externalNamespace: text("external_namespace").notNull(),
    // MemMachine `project_id`. Today: the OpenKT project UUID.
    externalProjectId: text("external_project_id").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    memoryProviderKindUnique: uniqueIndex("memory_external_refs_memory_provider_kind_unique")
      .on(table.memoryId, table.provider, table.externalKind),
    tenancyExternalUnique: uniqueIndex("memory_external_refs_tenancy_external_unique").on(
      table.provider,
      table.externalKind,
      table.externalNamespace,
      table.externalProjectId,
      table.externalId,
    ),
    tenancyLookupIdx: index("memory_external_refs_tenancy_lookup_idx").on(
      table.provider,
      table.externalKind,
      table.externalNamespace,
      table.externalProjectId,
      table.externalId,
    ),
  }),
);

export type MemoryExternalRef = typeof memoryExternalRefs.$inferSelect;
export type NewMemoryExternalRef = typeof memoryExternalRefs.$inferInsert;
