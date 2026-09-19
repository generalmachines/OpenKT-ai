import { z } from "zod";

import {
  type BuildCypherOutput,
  type CypherQuery,
  type GraphLibraryEdge,
  type GraphLibraryNode,
  type GraphLibraryResult,
  type Neo4jRecordLike,
} from "./types";

// `tag_contributors` — surfaces the top-N people contributing memories
// for a given tag inside the project. Returns:
//   - 1 `tag` node (the seed)
//   - up to N `user` nodes (contributors)
//   - up to (top_n * 10) `memory` nodes (their tagged memories)
//   - edges: tag<-tagged-memory<-authored-user
//
// All data lives in Postgres — Neo4j is irrelevant here. We still
// expose it through the Cypher library so the UI can switch
// visualizations across substrates without learning two protocols.

const TagContributorsParamsSchema = z.object({
  tag_id: z.string().uuid(),
  top_n: z.coerce.number().int().min(1).max(100).default(20),
});

export type TagContributorsParams = z.infer<typeof TagContributorsParamsSchema>;

export const tagContributorsQuery: CypherQuery<TagContributorsParams> = {
  name: "tag_contributors",
  description:
    "Top-N users contributing memories with the given tag in this project, plus the memory nodes " +
    "and authorship edges. Powers tag-cloud drilldowns.",
  backend: "postgres",
  paramSchema: TagContributorsParamsSchema,

  buildCypher(params, projectId): BuildCypherOutput {
    const topN = Math.max(1, Math.min(100, Math.floor(params.top_n)));
    // Two-pass: (1) pick top-N contributors by memory count, (2) list
    // their memories. Both passes scope by project_id so a request for
    // project A can't bleed into project B even via a stale tag.
    const sql = `
      with scoped_memory_tags as (
        select mt.memory_id, mt.tag_id, m.owner_user_id, m.content, m.created_at::text as created_at,
               m.project_id
        from memory_tags mt
        join memories m on m.id = mt.memory_id
        where mt.tag_id = $1::uuid
          and m.project_id = $2::uuid
          and m.archived = false
      ),
      tag_info as (
        select id::text as id, slug, display_name
        from tags
        where id = $1::uuid
      ),
      top_contributors as (
        select owner_user_id, count(*)::int as memory_count
        from scoped_memory_tags
        group by owner_user_id
        order by memory_count desc, owner_user_id asc
        limit ${topN}
      )
      select 'tag'::text as kind,
             ti.id as id,
             coalesce(ti.display_name, ti.slug) as label,
             null::int as memory_count,
             null::text as content,
             null::text as created_at,
             null::text as owner_user_id
      from tag_info ti
      union all
      select 'user'::text as kind,
             tc.owner_user_id::text as id,
             tc.owner_user_id::text as label,
             tc.memory_count as memory_count,
             null::text as content,
             null::text as created_at,
             tc.owner_user_id::text as owner_user_id
      from top_contributors tc
      union all
      select 'memory'::text as kind,
             smt.memory_id::text as id,
             left(coalesce(smt.content, ''), 80) as label,
             null::int as memory_count,
             smt.content as content,
             smt.created_at as created_at,
             smt.owner_user_id::text as owner_user_id
      from scoped_memory_tags smt
      join top_contributors tc on tc.owner_user_id = smt.owner_user_id
    `;
    return {
      cypher: sql,
      params: { $1: params.tag_id, $2: projectId },
    };
  },

  parseResult(records: Neo4jRecordLike[]): GraphLibraryResult {
    const nodes = new Map<string, GraphLibraryNode>();
    const edges: GraphLibraryEdge[] = [];
    let tagNodeId: string | null = null;

    for (const record of records) {
      const obj = (record.toObject ? record.toObject() : keysToObject(record)) as Record<string, unknown>;
      const kind = String(obj.kind ?? "");
      const id = String(obj.id ?? "");
      if (!id) continue;

      if (kind === "tag") {
        const nodeId = `tag_${id}`;
        tagNodeId = nodeId;
        nodes.set(nodeId, {
          id: nodeId,
          type: "tag",
          label: typeof obj.label === "string" ? obj.label : id,
        });
      } else if (kind === "user") {
        const nodeId = `user_${id}`;
        nodes.set(nodeId, {
          id: nodeId,
          type: "user",
          label: typeof obj.label === "string" ? obj.label : id,
          memory_count: typeof obj.memory_count === "number" ? obj.memory_count : 0,
        });
      } else if (kind === "memory") {
        const nodeId = `mem_${id}`;
        nodes.set(nodeId, {
          id: nodeId,
          type: "memory",
          label: typeof obj.label === "string" ? obj.label : `memory ${id.slice(0, 8)}`,
          created_at: typeof obj.created_at === "string" ? obj.created_at : null,
        });
        const owner = obj.owner_user_id ? String(obj.owner_user_id) : null;
        if (owner) {
          edges.push({
            source: `user_${owner}`,
            target: nodeId,
            kind: "authored",
            weight: null,
          });
        }
        if (tagNodeId) {
          edges.push({
            source: nodeId,
            target: tagNodeId,
            kind: "tagged_with",
            weight: null,
          });
        }
      }
    }

    // Two passes done; some `tagged_with` edges may have been queued
    // before the tag node was emitted (UNION ordering isn't guaranteed
    // across pg versions). Filter dangling edges defensively.
    const idSet = new Set(nodes.keys());
    const liveEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

    return {
      nodes: Array.from(nodes.values()),
      edges: liveEdges,
      stats: {
        node_count: nodes.size,
        edge_count: liveEdges.length,
        contributor_count: Array.from(nodes.values()).filter((n) => n.type === "user").length,
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
