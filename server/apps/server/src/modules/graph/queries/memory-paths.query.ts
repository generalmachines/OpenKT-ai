import { z } from "zod";

import {
  type BuildCypherOutput,
  type CypherQuery,
  type GraphLibraryEdge,
  type GraphLibraryNode,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "./types";

// `memory_paths` — given two memory ids, find the shortest path
// between them in Neo4j. Memories are recorded in Neo4j as nodes with
// an `openkt_memory_id` property (matching what Neo4jService writes).
// If no path is found we still return an OK response with empty
// node/edge arrays and `stats.path_exists = false`.

const MemoryPathsParamsSchema = z.object({
  from_memory_id: z.string().min(1).max(128),
  to_memory_id: z.string().min(1).max(128),
  max_depth: z.coerce.number().int().min(1).max(10).default(5),
});

export type MemoryPathsParams = z.infer<typeof MemoryPathsParamsSchema>;

export const memoryPathsQuery: CypherQuery<MemoryPathsParams> = {
  name: "memory_paths",
  description:
    "Shortest path between two memories through the knowledge graph (entities, episodes). " +
    "Returns empty arrays + stats.path_exists=false when no path exists.",
  backend: "neo4j",
  paramSchema: MemoryPathsParamsSchema,

  buildCypher(params, projectId): BuildCypherOutput {
    const maxDepth = Math.max(1, Math.min(10, Math.floor(params.max_depth)));
    // The two anchor matches both project-scope-fence the candidates.
    // We strip `mem_` prefix off the inputs because the UI may pass
    // either the raw uuid (the storage form on the Postgres side) or
    // the prefixed form we use elsewhere in the API.
    const cypher = `
      MATCH (start)
      WHERE coalesce(start.openkt_memory_id, start.uid, '') = $from_memory_id
        AND (
          coalesce(start.project_id, '') = $project_id
          OR coalesce(start.tenant_id, '') = $project_id
          OR coalesce(start.namespace, '') = $project_id
        )
      WITH start
      LIMIT 1
      MATCH (target)
      WHERE coalesce(target.openkt_memory_id, target.uid, '') = $to_memory_id
        AND (
          coalesce(target.project_id, '') = $project_id
          OR coalesce(target.tenant_id, '') = $project_id
          OR coalesce(target.namespace, '') = $project_id
        )
      WITH start, target
      LIMIT 1
      MATCH path = shortestPath((start)-[*1..${maxDepth}]-(target))
      RETURN nodes(path) AS path_nodes, relationships(path) AS path_rels
      LIMIT 1
    `;
    return {
      cypher,
      params: {
        from_memory_id: stripPrefix(params.from_memory_id, "mem_"),
        to_memory_id: stripPrefix(params.to_memory_id, "mem_"),
        project_id: projectId,
      },
    };
  },

  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult {
    if (records.length === 0) {
      return {
        nodes: [],
        edges: [],
        stats: { node_count: 0, edge_count: 0, path_exists: false, depth_reached: 0 },
      };
    }

    const record = records[0];
    const pathNodes = (record.get("path_nodes") as unknown[]) ?? [];
    const pathRels = (record.get("path_rels") as unknown[]) ?? [];

    const nodes: GraphLibraryNode[] = [];
    const seen = new Set<string>();
    const nodeIds: string[] = [];
    for (const raw of pathNodes) {
      const view = nodeView(raw);
      nodeIds.push(view.id);
      if (seen.has(view.id)) continue;
      seen.add(view.id);
      nodes.push({
        id: view.id,
        type: view.type,
        label: view.label,
        neo4j_node_id: view.neo4jNodeId,
      });
    }

    const edges: GraphLibraryEdge[] = pathRels.map((raw, index) => {
      const rel = relView(raw);
      return {
        source: nodeIds[index] ?? "?",
        target: nodeIds[index + 1] ?? "?",
        kind: rel.kind,
        weight: rel.weight,
      };
    });

    return {
      nodes,
      edges,
      stats: {
        node_count: nodes.length,
        edge_count: edges.length,
        path_exists: nodes.length > 0,
        depth_reached: pathRels.length,
      },
    };
  },
};

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

interface NodeView {
  id: string;
  type: string;
  label: string;
  neo4jNodeId: string | null;
}

function nodeView(raw: unknown): NodeView {
  if (!raw || typeof raw !== "object") {
    return { id: "unknown", type: "unknown", label: "unknown", neo4jNodeId: null };
  }
  const props =
    (raw as { properties?: Record<string, unknown> }).properties ?? (raw as Record<string, unknown>);
  const labels = (raw as { labels?: unknown }).labels;
  const identityRaw = (raw as { identity?: unknown }).identity;
  const neo4jId = identityRaw !== undefined && identityRaw !== null ? String(identityRaw) : null;
  const labelStr =
    Array.isArray(labels) && labels.length > 0 ? String(labels[0]).toLowerCase() : "unknown";

  let type = "entity";
  let idPrefix = "ent_";
  if (props.openkt_memory_id || labelStr === "memory") {
    type = "memory";
    idPrefix = "mem_";
  } else if (props.openkt_episode_id || labelStr === "episode") {
    type = "episode";
    idPrefix = "ep_";
  }

  const rawId =
    props.openkt_memory_id ??
    props.openkt_episode_id ??
    props.openkt_entity_id ??
    props.id ??
    props.uid ??
    props.name ??
    neo4jId ??
    "unknown";

  const id = `${idPrefix}${String(rawId)}`;
  const label = String(props.name ?? props.label ?? props.summary ?? rawId).slice(0, 80);
  return { id, type, label, neo4jNodeId: neo4jId };
}

interface RelView {
  kind: string;
  weight: number | null;
}

function relView(raw: unknown): RelView {
  if (!raw || typeof raw !== "object") return { kind: "related", weight: null };
  const type = (raw as { type?: unknown }).type;
  const props = (raw as { properties?: Record<string, unknown> }).properties ?? {};
  const weight = toNumberOrNull(props.weight ?? props.score);
  return { kind: typeof type === "string" ? type.toLowerCase() : "related", weight };
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
