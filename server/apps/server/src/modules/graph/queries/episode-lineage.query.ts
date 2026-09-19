import { z } from "zod";

import {
  type BuildCypherOutput,
  type CypherQuery,
  type GraphLibraryEdge,
  type GraphLibraryNode,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "./types";

// `episode_lineage` — supersede / fork chain read from Postgres
// (`episodes.previous_episode_id`). NOT Neo4j; that database holds the
// entity graph, not the supersede ledger. Returns the chain in
// node/edge shape so the frontend can drop it straight into the same
// graph component used for entity_neighbors.

const EpisodeLineageParamsSchema = z.object({
  episode_id: z.string().uuid(),
  direction: z.enum(["ancestors", "descendants", "both"]).default("both"),
  max_depth: z.coerce.number().int().min(1).max(20).default(10),
});

export type EpisodeLineageParams = z.infer<typeof EpisodeLineageParamsSchema>;

export const episodeLineageQuery: CypherQuery<EpisodeLineageParams> = {
  name: "episode_lineage",
  description:
    "Walks the supersede/fork chain of an episode (Postgres episodes.previous_episode_id) and " +
    "returns the chain as graph nodes + 'supersedes' edges.",
  backend: "postgres",
  paramSchema: EpisodeLineageParamsSchema,

  buildCypher(params, projectId): BuildCypherOutput {
    // Recursive CTE: walk ancestors via `previous_episode_id` and/or
    // descendants by joining on the reverse direction. `max_depth` is
    // expressed as `level <= $max_depth` to keep the query bounded.
    const depth = Math.max(1, Math.min(20, Math.floor(params.max_depth)));
    const wantAncestors = params.direction === "ancestors" || params.direction === "both";
    const wantDescendants = params.direction === "descendants" || params.direction === "both";

    const ancestorBranch = wantAncestors
      ? `
        select e.id, e.name, e.summary, e.member_count, e.created_at, e.previous_episode_id,
               -1 as level, 'ancestor'::text as side
        from episodes e
        where e.id = $1::uuid and e.project_id = $2::uuid
        union all
        select e.id, e.name, e.summary, e.member_count, e.created_at, e.previous_episode_id,
               anc.level - 1 as level, 'ancestor'::text as side
        from episodes e
        join lineage anc on anc.previous_episode_id = e.id and anc.side = 'ancestor'
        where e.project_id = $2::uuid and abs(anc.level) < ${depth}
      `
      : null;

    const descendantBranch = wantDescendants
      ? `
        select e.id, e.name, e.summary, e.member_count, e.created_at, e.previous_episode_id,
               1 as level, 'descendant'::text as side
        from episodes e
        where e.previous_episode_id = $1::uuid and e.project_id = $2::uuid
        union all
        select e.id, e.name, e.summary, e.member_count, e.created_at, e.previous_episode_id,
               desc.level + 1 as level, 'descendant'::text as side
        from episodes e
        join lineage desc on desc.id = e.previous_episode_id and desc.side = 'descendant'
        where e.project_id = $2::uuid and desc.level < ${depth}
      `
      : null;

    const root = `
      select id, name, summary, member_count, created_at, previous_episode_id,
             0 as level, 'root'::text as side
      from episodes
      where id = $1::uuid and project_id = $2::uuid
    `;

    const branches: string[] = [root];
    if (ancestorBranch) branches.push(ancestorBranch);
    if (descendantBranch) branches.push(descendantBranch);

    const sql = `
      with recursive lineage as (
        ${branches.join("\n        union all\n        ")}
      )
      select distinct
        id::text as id,
        name,
        summary,
        member_count,
        created_at::text as created_at,
        previous_episode_id::text as previous_episode_id,
        level
      from lineage
      order by level asc
    `;
    return {
      cypher: sql,
      params: { $1: params.episode_id, $2: projectId },
    };
  },

  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult {
    const nodes = new Map<string, GraphLibraryNode>();
    const edges: GraphLibraryEdge[] = [];
    let minLevel = 0;
    let maxLevel = 0;

    for (const record of records) {
      const obj = (record.toObject ? record.toObject() : keysToObject(record)) as Record<string, unknown>;
      const id = String(obj.id ?? "");
      if (!id) continue;
      const previous = obj.previous_episode_id ? String(obj.previous_episode_id) : null;
      const level = Number(obj.level ?? 0);
      minLevel = Math.min(minLevel, level);
      maxLevel = Math.max(maxLevel, level);

      const nodeId = `ep_${id}`;
      nodes.set(nodeId, {
        id: nodeId,
        type: "episode",
        label: typeof obj.name === "string" ? obj.name : `episode ${id.slice(0, 8)}`,
        summary: typeof obj.summary === "string" ? obj.summary : null,
        member_count: typeof obj.member_count === "number" ? obj.member_count : 0,
        created_at: typeof obj.created_at === "string" ? obj.created_at : null,
        lineage_level: level,
      });

      if (previous) {
        edges.push({
          source: `ep_${id}`,
          target: `ep_${previous}`,
          kind: "supersedes",
          weight: null,
        });
      }
    }

    // Edges may reference ancestors we didn't include (e.g. the chain
    // climbed past max_depth). Drop dangling edges so the graph stays
    // self-consistent.
    const idSet = new Set(nodes.keys());
    const liveEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

    return {
      nodes: Array.from(nodes.values()),
      edges: liveEdges,
      stats: {
        node_count: nodes.size,
        edge_count: liveEdges.length,
        depth_reached: Math.max(Math.abs(minLevel), maxLevel),
      },
    };
  },
};

function keysToObject(record: Neo4jRecordLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of record.keys) {
    out[key] = record.get(key);
  }
  return out;
}
