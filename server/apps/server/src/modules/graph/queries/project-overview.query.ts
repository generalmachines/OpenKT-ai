import { z } from "zod";

import {
  type BuildCypherOutput,
  type CypherQuery,
  type GraphLibraryEdge,
  type GraphLibraryNode,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "./types";

// `project_overview` — bird's-eye dashboard view. Returns:
//   - one summary record per included `kind` carrying a count, plus
//   - up to 5 sample nodes per kind (the most recent / most used).
//
// The dashboard landing page renders this as a five-card layout, one
// card per node kind. We expose entity centrality on its own query
// (`entity_centrality`) so the dashboard can request a richer view
// without paying for it here.
//
// Backend: Postgres for memories / episodes / tags / contributors.
// Entities live in Neo4j, but on this query we return a placeholder
// count so the dashboard renders consistently even when Neo4j is
// unreachable — the service can layer entity facts on top of the
// result.

const INCLUDE_KEYS = ["memories", "episodes", "entities", "tags", "contributors"] as const;
export type ProjectOverviewInclude = (typeof INCLUDE_KEYS)[number];

const ProjectOverviewParamsSchema = z.object({
  include: z
    .array(z.enum(INCLUDE_KEYS))
    .optional()
    .transform((value) => (value && value.length > 0 ? value : [...INCLUDE_KEYS])),
});

export type ProjectOverviewParams = z.infer<typeof ProjectOverviewParamsSchema>;

export const projectOverviewQuery: CypherQuery<ProjectOverviewParams> = {
  name: "project_overview",
  description:
    "Bird's-eye counts + 5-sample nodes for memories/episodes/entities/tags/contributors. " +
    "Powers the dashboard landing card grid. `include` defaults to all five.",
  backend: "postgres",
  paramSchema: ProjectOverviewParamsSchema,

  buildCypher(params, projectId): BuildCypherOutput {
    const include = new Set(params.include);
    // We assemble one UNION ALL with one `kind` column per logical
    // section. Every section either contributes a `count` row (with id
    // = 'count') or a `sample` row (with id = the actual entity id).
    const sections: string[] = [];

    if (include.has("memories")) {
      sections.push(`
        select 'memories'::text as kind,
               'count'::text as sample_kind,
               null::text as id,
               null::text as label,
               (select count(*) from memories where project_id = $1::uuid and archived = false)::int as count,
               null::text as created_at
      `);
      sections.push(`
        select 'memories'::text as kind,
               'sample'::text as sample_kind,
               id::text as id,
               left(coalesce(content, ''), 80) as label,
               null::int as count,
               created_at::text as created_at
        from memories
        where project_id = $1::uuid and archived = false
        order by created_at desc
        limit 5
      `);
    }

    if (include.has("episodes")) {
      sections.push(`
        select 'episodes'::text as kind,
               'count'::text as sample_kind,
               null::text as id,
               null::text as label,
               (select count(*) from episodes where project_id = $1::uuid)::int as count,
               null::text as created_at
      `);
      sections.push(`
        select 'episodes'::text as kind,
               'sample'::text as sample_kind,
               id::text as id,
               name as label,
               null::int as count,
               created_at::text as created_at
        from episodes
        where project_id = $1::uuid
        order by updated_at desc
        limit 5
      `);
    }

    if (include.has("tags")) {
      sections.push(`
        select 'tags'::text as kind,
               'count'::text as sample_kind,
               null::text as id,
               null::text as label,
               (
                 select count(distinct t.id)
                 from tags t
                 join memory_tags mt on mt.tag_id = t.id
                 join memories m on m.id = mt.memory_id
                 where m.project_id = $1::uuid
               )::int as count,
               null::text as created_at
      `);
      sections.push(`
        select 'tags'::text as kind,
               'sample'::text as sample_kind,
               t.id::text as id,
               coalesce(t.display_name, t.slug) as label,
               count(mt.memory_id)::int as count,
               null::text as created_at
        from tags t
        join memory_tags mt on mt.tag_id = t.id
        join memories m on m.id = mt.memory_id
        where m.project_id = $1::uuid
        group by t.id, t.display_name, t.slug
        order by count(mt.memory_id) desc
        limit 5
      `);
    }

    if (include.has("contributors")) {
      sections.push(`
        select 'contributors'::text as kind,
               'count'::text as sample_kind,
               null::text as id,
               null::text as label,
               (
                 select count(distinct owner_user_id)
                 from memories
                 where project_id = $1::uuid and archived = false
               )::int as count,
               null::text as created_at
      `);
      sections.push(`
        select 'contributors'::text as kind,
               'sample'::text as sample_kind,
               owner_user_id::text as id,
               owner_user_id::text as label,
               count(*)::int as count,
               null::text as created_at
        from memories
        where project_id = $1::uuid and archived = false
        group by owner_user_id
        order by count(*) desc
        limit 5
      `);
    }

    // For 'entities' we cannot read Neo4j from a Postgres query — the
    // service layer fills this kind in separately and merges. But we
    // still emit a placeholder row when 'entities' is requested so the
    // returned shape lists all requested kinds even when no entities
    // are available.
    if (include.has("entities")) {
      sections.push(`
        select 'entities'::text as kind,
               'placeholder'::text as sample_kind,
               null::text as id,
               null::text as label,
               null::int as count,
               null::text as created_at
      `);
    }

    // Guard against empty include set (shouldn't happen given the
    // schema default but cheap insurance).
    const sql = sections.length > 0
      ? sections.join("\n      union all\n      ")
      : "select null::text as kind, null::text as sample_kind, null::text as id, null::text as label, null::int as count, null::text as created_at where false";

    return { cypher: sql, params: { $1: projectId } };
  },

  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult {
    const counts = new Map<string, number>();
    const samples = new Map<string, GraphLibraryNode[]>();
    const requestedKinds = new Set<string>();

    for (const record of records) {
      const obj = (record.toObject ? record.toObject() : keysToObject(record)) as Record<string, unknown>;
      const kind = typeof obj.kind === "string" ? obj.kind : null;
      if (!kind) continue;
      requestedKinds.add(kind);
      const sampleKind = typeof obj.sample_kind === "string" ? obj.sample_kind : "sample";

      if (sampleKind === "count") {
        counts.set(kind, toInt(obj.count));
        continue;
      }
      if (sampleKind === "placeholder") {
        continue;
      }

      const id = obj.id ? String(obj.id) : null;
      if (!id) continue;
      const nodeId = nodeIdForKind(kind, id);
      const label = obj.label ? String(obj.label) : id;
      const node: GraphLibraryNode = {
        id: nodeId,
        type: singularKindType(kind),
        label,
      };
      if (obj.created_at) node.created_at = String(obj.created_at);
      if (obj.count !== null && obj.count !== undefined) node.use_count = toInt(obj.count);

      const list = samples.get(kind) ?? [];
      list.push(node);
      samples.set(kind, list);
    }

    const flatNodes: GraphLibraryNode[] = [];
    for (const list of samples.values()) {
      for (const node of list) flatNodes.push(node);
    }

    const countsObj: Record<string, number> = {};
    for (const kind of requestedKinds) {
      countsObj[kind] = counts.get(kind) ?? 0;
    }

    const edges: GraphLibraryEdge[] = [];
    return {
      nodes: flatNodes,
      edges,
      stats: {
        node_count: flatNodes.length,
        edge_count: 0,
        counts: countsObj,
        included_kinds: Array.from(requestedKinds),
      },
    };
  },
};

function nodeIdForKind(kind: string, rawId: string): string {
  switch (kind) {
    case "memories":
      return `mem_${rawId}`;
    case "episodes":
      return `ep_${rawId}`;
    case "tags":
      return `tag_${rawId}`;
    case "contributors":
      return `user_${rawId}`;
    case "entities":
      return `ent_${rawId}`;
    default:
      return rawId;
  }
}

function singularKindType(kind: string): string {
  switch (kind) {
    case "memories":
      return "memory";
    case "episodes":
      return "episode";
    case "entities":
      return "entity";
    case "tags":
      return "tag";
    case "contributors":
      return "user";
    default:
      return kind;
  }
}

function toInt(value: unknown): number {
  if (typeof value === "number") return Math.max(0, Math.floor(value));
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    try {
      return Math.max(0, Math.floor((value as { toNumber: () => number }).toNumber()));
    } catch {
      return 0;
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function keysToObject(record: Neo4jRecordLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of record.keys) {
    out[key] = record.get(key);
  }
  return out;
}
