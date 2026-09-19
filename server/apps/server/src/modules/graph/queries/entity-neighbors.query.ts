import { z } from "zod";

import {
  type BuildCypherOutput,
  type CypherQuery,
  type GraphLibraryEdge,
  type GraphLibraryNode,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "./types";

// `entity_neighbors` — for the "click an entity, see its neighborhood"
// click-to-expand UI. Variable-length pattern is bounded at depth 3 so
// a careless `?depth=99` can't blow up the database. We project the
// path back as a list of nodes + relationships, then flatten in code
// because Cypher's `nodes(p)` / `relationships(p)` return order is
// path-relative and we want a deduplicated graph.

const EntityNeighborsParamsSchema = z.object({
  entity_id: z.string().min(1).max(128),
  depth: z.coerce.number().int().min(1).max(3).default(2),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type EntityNeighborsParams = z.infer<typeof EntityNeighborsParamsSchema>;

export const entityNeighborsQuery: CypherQuery<EntityNeighborsParams> = {
  name: "entity_neighbors",
  description:
    "Returns the given entity and the entities connected to it via MENTIONS-style edges, up to N hops away. " +
    "Use for click-an-entity drilldowns.",
  backend: "neo4j",
  paramSchema: EntityNeighborsParamsSchema,

  buildCypher(params, projectId): BuildCypherOutput {
    // Cypher's variable-length path syntax does NOT accept `$depth` as
    // a parameter, so we inline the integer after validating it. The
    // Zod schema clamps to 1..3 so the inlined value is always safe.
    const depth = Math.max(1, Math.min(3, Math.floor(params.depth)));
    const cypher = `
      MATCH (root)
      WHERE any(label IN labels(root) WHERE label IN ['Entity','SemanticEntity','Concept'])
        AND coalesce(root.openkt_entity_id, root.id, root.name, toString(id(root))) = $entity_id
        AND (
          coalesce(root.project_id, '') = $project_id
          OR coalesce(root.tenant_id, '') = $project_id
          OR coalesce(root.namespace, '') = $project_id
        )
      WITH root
      LIMIT 1
      MATCH path = (root)-[*1..${depth}]-(neighbour)
      WHERE any(label IN labels(neighbour) WHERE label IN ['Entity','SemanticEntity','Concept'])
        AND all(
          rel IN relationships(path)
          WHERE type(rel) IN ['MENTIONS','REFERS_TO','ABOUT','HAS_ENTITY','RELATED_TO']
        )
        AND (
          coalesce(neighbour.project_id, '') = $project_id
          OR coalesce(neighbour.tenant_id, '') = $project_id
          OR coalesce(neighbour.namespace, '') = $project_id
        )
      WITH root, neighbour, path
      LIMIT $limit
      RETURN
        nodes(path) AS path_nodes,
        relationships(path) AS path_rels
    `;
    return {
      cypher,
      params: {
        entity_id: params.entity_id,
        project_id: projectId,
        limit: params.limit,
      },
    };
  },

  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult {
    const nodes = new Map<string, GraphLibraryNode>();
    const edgeKey = (e: GraphLibraryEdge) => `${e.source}->${e.target}:${e.kind}`;
    const edges = new Map<string, GraphLibraryEdge>();
    let maxDepthSeen = 0;

    for (const record of records) {
      const pathNodes = (record.get("path_nodes") as unknown[]) ?? [];
      const pathRels = (record.get("path_rels") as unknown[]) ?? [];
      maxDepthSeen = Math.max(maxDepthSeen, pathRels.length);

      const nodeIdAtIndex: string[] = [];
      for (const raw of pathNodes) {
        const view = nodeView(raw);
        const id = view.id;
        nodeIdAtIndex.push(id);
        if (!nodes.has(id)) {
          nodes.set(id, {
            id,
            type: "entity",
            label: view.label,
            entity_kind: view.entityKind,
            neo4j_node_id: view.neo4jNodeId,
          });
        }
      }

      pathRels.forEach((raw, index) => {
        const rel = relView(raw);
        const source = nodeIdAtIndex[index];
        const target = nodeIdAtIndex[index + 1];
        if (!source || !target) return;
        const edge: GraphLibraryEdge = {
          source,
          target,
          kind: rel.kind,
          weight: rel.weight,
        };
        edges.set(edgeKey(edge), edge);
      });
    }

    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      stats: {
        node_count: nodes.size,
        edge_count: edges.size,
        depth_reached: maxDepthSeen,
      },
    };
  },
};

// ── helpers ───────────────────────────────────────────────────────────

interface NodeView {
  id: string;
  label: string;
  entityKind: string | null;
  neo4jNodeId: string | null;
}

function nodeView(raw: unknown): NodeView {
  if (!raw || typeof raw !== "object") {
    return { id: "unknown", label: "unknown", entityKind: null, neo4jNodeId: null };
  }
  const props = (raw as { properties?: Record<string, unknown> }).properties ?? (raw as Record<string, unknown>);
  const labels = (raw as { labels?: unknown }).labels;
  const identityRaw = (raw as { identity?: unknown }).identity;
  const neo4jId = identityRaw !== undefined && identityRaw !== null ? toIdString(identityRaw) : null;
  const id = String(
    props.openkt_entity_id ??
      props.id ??
      props.name ??
      props.label ??
      neo4jId ??
      "unknown",
  );
  const label = String(
    props.name ??
      props.label ??
      props.id ??
      neo4jId ??
      "unknown",
  ).trim() || id;
  const entityKind =
    typeof props.entity_kind === "string"
      ? props.entity_kind
      : typeof props.type === "string"
        ? props.type
        : Array.isArray(labels) && labels[0]
          ? String(labels[0])
          : null;
  return { id, label, entityKind, neo4jNodeId: neo4jId };
}

interface RelView {
  kind: string;
  weight: number | null;
}

function relView(raw: unknown): RelView {
  if (!raw || typeof raw !== "object") return { kind: "RELATED", weight: null };
  const type = (raw as { type?: unknown }).type;
  const props = (raw as { properties?: Record<string, unknown> }).properties ?? {};
  const weight = toNumberOrNull(props.weight ?? props.score);
  const kind = typeof type === "string" ? type.toLowerCase() : "related";
  return { kind, weight };
}

function toIdString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (typeof value === "object" && value !== null && "toString" in value) {
    try {
      return String((value as { toString: () => string }).toString());
    } catch {
      return "";
    }
  }
  return String(value);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    try {
      const n = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
