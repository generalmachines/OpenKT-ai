import { z } from "zod";

import {
  type BuildCypherOutput,
  type CypherQuery,
  type GraphLibraryEdge,
  type GraphLibraryNode,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "./types";

// `entity_centrality` — degree-style centrality on the entity graph,
// counting MENTIONS edges arriving at each entity from memories created
// since `$since`. This is not full PageRank — that's a future addition
// via APOC — but it's a meaningful "what's everyone been talking about
// lately" signal that the dashboard can render as a top-N bar list.

const EntityCentralityParamsSchema = z.object({
  top_n: z.coerce.number().int().min(1).max(100).default(25),
  since: z.string().datetime().optional(),
});

export type EntityCentralityParams = z.infer<typeof EntityCentralityParamsSchema>;

export const entityCentralityQuery: CypherQuery<EntityCentralityParams> = {
  name: "entity_centrality",
  description:
    "Top-N entities ranked by MENTIONS-edge count from project memories. " +
    "When `since` is provided, only memories whose created_at >= since are counted.",
  backend: "neo4j",
  paramSchema: EntityCentralityParamsSchema,

  buildCypher(params, projectId): BuildCypherOutput {
    const topN = Math.max(1, Math.min(100, Math.floor(params.top_n)));
    const sinceClause = params.since
      ? "AND coalesce(m.created_at, m.openkt_created_at, '') >= $since"
      : "";
    const cypher = `
      MATCH (m)-[r]->(e)
      WHERE any(label IN labels(e) WHERE label IN ['Entity','SemanticEntity','Concept'])
        AND type(r) IN ['MENTIONS','REFERS_TO','ABOUT','HAS_ENTITY']
        AND (
          coalesce(e.project_id, m.project_id, '') = $project_id
          OR coalesce(e.tenant_id, m.tenant_id, '') = $project_id
          OR coalesce(m.namespace, '') = $project_id
        )
        ${sinceClause}
      WITH e, count(distinct m) AS mention_count
      RETURN
        id(e) AS node_id,
        coalesce(e.openkt_entity_id, e.id, e.name, toString(id(e))) AS entity_key,
        coalesce(e.name, e.label, e.id) AS label,
        coalesce(e.entity_kind, e.type, head(labels(e))) AS entity_kind,
        mention_count
      ORDER BY mention_count DESC, entity_key ASC
      LIMIT $top_n
    `;
    return {
      cypher,
      params: {
        project_id: projectId,
        top_n: topN,
        ...(params.since ? { since: params.since } : {}),
      },
    };
  },

  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult {
    const nodes: GraphLibraryNode[] = [];
    const edges: GraphLibraryEdge[] = [];

    for (const record of records) {
      const obj = (record.toObject ? record.toObject() : keysToObject(record)) as Record<string, unknown>;
      const rawKey = String(obj.entity_key ?? obj.node_id ?? "");
      if (!rawKey) continue;
      const id = `ent_${rawKey}`;
      const mentionCount = toInt(obj.mention_count);
      nodes.push({
        id,
        type: "entity",
        label: String(obj.label ?? rawKey),
        entity_kind: typeof obj.entity_kind === "string" ? obj.entity_kind : null,
        neo4j_node_id: obj.node_id !== undefined && obj.node_id !== null ? String(obj.node_id) : null,
        mention_count: mentionCount,
        centrality_score: mentionCount,
      });
    }

    return {
      nodes,
      edges,
      stats: {
        node_count: nodes.length,
        edge_count: 0,
        ranked_by: "mention_count_desc",
      },
    };
  },
};

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
