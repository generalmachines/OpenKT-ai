import { Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { requireProjectAccess } from "@openkt/auth-authorization";
import { NotFoundDomainError } from "@openkt/core-errors";

import type {
  GraphEdge,
  GraphNode,
  GraphQuery,
  GraphResponse,
  GraphEdgeKind,
} from "../contracts/graph.contract";
import {
  EDGE_KINDS,
} from "../contracts/graph.contract";
import {
  GraphRepository,
  type MemoryRow,
  type EpisodeRow,
} from "./graph.repository";
import { Neo4jService } from "./neo4j.service";

const SIMILARITY_THRESHOLD = 0.85;
const SIMILARITY_PER_NODE_CAP = 6;

// GraphService is the read-only assembler for the Obsidian-style
// /v1/projects/:project_id/graph endpoint. It does not write to any
// store. The merge ordering is intentional:
//   1. Episodes first (most semantically meaningful "nodes" in the
//      knowledge graph; survive the limit cap preferentially).
//   2. Memories (contributors of those episodes are guaranteed to be
//      in the set when they share the limit budget).
//   3. Entities (Neo4j; only attached when neo4j-driver + a reachable
//      MemMachine Neo4j are present).
//
// The `focus` param trims the graph to the focused node's neighborhood
// using BFS over the assembled edge set, expanding `depth` hops out.

@Injectable()
export class GraphService {
  constructor(
    private readonly repository: GraphRepository,
    private readonly neo4j: Neo4jService,
  ) {}

  async build(
    context: ActorContext,
    projectId: string,
    query: GraphQuery,
  ): Promise<GraphResponse> {
    await requireProjectAccess(context, projectId, "read");
    const project = await this.repository.getProjectFocus(projectId);
    if (!project) throw new NotFoundDomainError("project");

    const include = new Set(query.include);
    const limit = query.limit;

    // ── 1) Episodes ─────────────────────────────────────────────────
    const episodeRows = include.has("episodes")
      ? await this.repository.listEpisodes(projectId, limit)
      : [];

    // ── 2) Memories ─────────────────────────────────────────────────
    const memoryBudget = Math.max(
      0,
      limit - episodeRows.length,
    );
    const memoryRows = include.has("memories")
      ? await this.repository.listMemories(projectId, memoryBudget)
      : [];

    // ── 3) Entities (Neo4j) ─────────────────────────────────────────
    const neo4jAvailable = this.neo4j.isConfigured();
    const entityNodes = include.has("entities") && neo4jAvailable
      ? await this.neo4j.listEntitiesForProject({
          orgId: project.org_id,
          projectId,
          ownerUserId: project.owner_user_id,
          limit: Math.min(limit, 200),
        })
      : [];

    // ── Assemble nodes ──────────────────────────────────────────────
    const nodes = new Map<string, GraphNode>();

    for (const episode of episodeRows) {
      const id = `ep_${episode.id}`;
      nodes.set(id, this.toEpisodeNode(id, episode));
    }

    for (const memory of memoryRows) {
      const id = `mem_${memory.id}`;
      nodes.set(id, this.toMemoryNode(id, memory));
    }

    for (const entity of entityNodes) {
      nodes.set(entity.id, {
        id: entity.id,
        type: "entity",
        label: entity.label,
        neo4j_node_id: entity.neo4jNodeId,
        entity_kind: entity.entityKind,
        // memory_count is recomputed below once we know which
        // mentions edges land in the kept set.
        memory_count: 0,
      });
    }

    // ── Assemble edges ──────────────────────────────────────────────
    const edges: GraphEdge[] = [];

    if (include.has("episodes") && include.has("memories")) {
      const episodeMemoryEdges = await this.repository.listEpisodeMemoryEdges(
        projectId,
        limit * 10,
      );
      for (const row of episodeMemoryEdges) {
        const source = `mem_${row.memory_id}`;
        const target = `ep_${row.episode_id}`;
        if (!nodes.has(source) || !nodes.has(target)) continue;
        edges.push({
          source,
          target,
          kind: "contributes_to",
          weight: row.similarity_at_join,
        });
      }
    }

    if (include.has("similarity")) {
      const similarityRows = await this.repository.listSimilarityEdges(
        projectId,
        SIMILARITY_THRESHOLD,
        SIMILARITY_PER_NODE_CAP,
      );
      for (const row of similarityRows) {
        const source = `mem_${row.source}`;
        const target = `mem_${row.target}`;
        if (!nodes.has(source) || !nodes.has(target)) continue;
        edges.push({
          source,
          target,
          kind: "similar",
          weight: row.similarity,
        });
      }
    }

    if (include.has("entities") && neo4jAvailable) {
      const mentionEdges = await this.neo4j.listMentionEdgesForProject({
        orgId: project.org_id,
        projectId,
        ownerUserId: project.owner_user_id,
        limit: limit * 5,
      });
      for (const edge of mentionEdges) {
        if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
        edges.push({
          source: edge.source,
          target: edge.target,
          kind: "mentions",
          weight: edge.weight,
        });
      }
      // Recompute entity memory counts from kept mentions edges.
      const mentionCounts = new Map<string, number>();
      for (const edge of edges) {
        if (edge.kind !== "mentions") continue;
        mentionCounts.set(edge.target, (mentionCounts.get(edge.target) ?? 0) + 1);
      }
      for (const node of nodes.values()) {
        if (node.type === "entity") {
          node.memory_count = mentionCounts.get(node.id) ?? 0;
        }
      }
    }

    // ── Apply focus + depth ─────────────────────────────────────────
    const focused = query.focus
      ? this.focusNeighborhood(query.focus, nodes, edges, query.depth)
      : { nodeIds: new Set(nodes.keys()), focus: null as string | null };

    const finalNodes: GraphNode[] = [];
    for (const node of nodes.values()) {
      if (focused.nodeIds.has(node.id)) finalNodes.push(node);
    }

    const finalEdges = edges.filter(
      (edge) => focused.nodeIds.has(edge.source) && focused.nodeIds.has(edge.target),
    );

    const truncated = finalNodes.length >= limit;
    const finalNodesCapped = truncated ? finalNodes.slice(0, limit) : finalNodes;
    const keptIds = new Set(finalNodesCapped.map((node) => node.id));
    const finalEdgesCapped = finalEdges.filter(
      (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
    );

    return {
      nodes: finalNodesCapped,
      edges: finalEdgesCapped,
      stats: {
        node_count: finalNodesCapped.length,
        edge_count: finalEdgesCapped.length,
        focus: focused.focus,
        depth: query.focus ? query.depth : 0,
        truncated,
        neo4j_available: neo4jAvailable,
      },
      legend: {
        node_types: ["memory", "episode", "entity"],
        edge_kinds: [...EDGE_KINDS] as GraphEdgeKind[],
      },
    };
  }

  private toEpisodeNode(id: string, row: EpisodeRow): GraphNode {
    return {
      id,
      type: "episode",
      label: row.name,
      summary: row.summary,
      member_count: row.member_count,
      archived: false,
      created_at: row.created_at,
    };
  }

  private toMemoryNode(id: string, row: MemoryRow): GraphNode {
    const preview = (row.content ?? "").replace(/\s+/g, " ").slice(0, 80);
    return {
      id,
      type: "memory",
      label: preview || `memory ${row.id.slice(0, 8)}`,
      kind: row.kind,
      confidence: row.confidence !== null ? Number(row.confidence) : null,
      actor_id: row.owner_user_id,
      archived: row.archived,
      created_at: row.created_at,
    };
  }

  private focusNeighborhood(
    rawFocus: string,
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    depth: number,
  ): { nodeIds: Set<string>; focus: string | null } {
    const candidates = [
      rawFocus,
      `mem_${rawFocus}`,
      `ep_${rawFocus}`,
      `ent_${rawFocus}`,
    ];
    const resolved = candidates.find((candidate) => nodes.has(candidate)) ?? null;
    if (!resolved) {
      // Unknown focus → empty subgraph, but return the focus string so
      // the caller can tell it was honored (just produced nothing).
      return { nodeIds: new Set(), focus: rawFocus };
    }

    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      addAdj(adjacency, edge.source, edge.target);
      addAdj(adjacency, edge.target, edge.source);
    }

    const visited = new Set<string>([resolved]);
    let frontier: string[] = [resolved];
    for (let hop = 0; hop < depth; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbours = adjacency.get(id);
        if (!neighbours) continue;
        for (const neighbour of neighbours) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return { nodeIds: visited, focus: resolved };
  }
}

function addAdj(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}
