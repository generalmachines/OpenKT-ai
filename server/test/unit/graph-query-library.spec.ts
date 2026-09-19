// Unit coverage for the named Cypher / SQL query library.
//
// For each query we assert:
//   - The Zod schema rejects bad params.
//   - `buildCypher(...)` binds project_id from the path (not from the
//     client) and produces the expected parameter map.
//   - `parseResult(...)` shapes the stubbed records into the documented
//     node / edge response.
//
// The Neo4j-backed queries use a fake record shape that mirrors
// neo4j-driver's `{ identity, labels, properties }` node payload plus
// the `{ type, properties }` relationship payload.

import {
  entityCentralityQuery,
  entityNeighborsQuery,
  episodeLineageQuery,
  memoryPathsQuery,
  projectOverviewQuery,
  tagContributorsQuery,
  QUERY_NAMES,
  getQuery,
} from "../../apps/server/src/modules/graph/queries";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const EP_A = "00000000-0000-4000-8000-00000000aaaa";
const EP_B = "00000000-0000-4000-8000-00000000bbbb";
const TAG_X = "00000000-0000-4000-8000-00000000cccc";

function mkRecord(obj: Record<string, unknown>) {
  return {
    keys: Object.keys(obj),
    get: (key: string) => obj[key],
    toObject: () => obj,
  };
}

function mkNeoNode(opts: {
  labels: string[];
  properties: Record<string, unknown>;
  identity?: string;
}) {
  return {
    identity: opts.identity ?? "0",
    labels: opts.labels,
    properties: opts.properties,
  };
}

function mkNeoRel(opts: { type: string; properties?: Record<string, unknown> }) {
  return { type: opts.type, properties: opts.properties ?? {} };
}

describe("graph query library — registry", () => {
  it("exposes the six required query names", () => {
    expect(new Set(QUERY_NAMES)).toEqual(
      new Set([
        "entity_neighbors",
        "episode_lineage",
        "tag_contributors",
        "memory_paths",
        "entity_centrality",
        "project_overview",
      ]),
    );
  });

  it("returns null for unknown names", () => {
    expect(getQuery("totally-bogus")).toBeNull();
  });
});

describe("entity_neighbors", () => {
  it("rejects params outside the 1..3 depth band", () => {
    const ok = entityNeighborsQuery.paramSchema.safeParse({ entity_id: "x", depth: 2 });
    expect(ok.success).toBe(true);
    const tooDeep = entityNeighborsQuery.paramSchema.safeParse({ entity_id: "x", depth: 9 });
    expect(tooDeep.success).toBe(false);
  });

  it("binds project_id from the path and inlines the depth literal", () => {
    const built = entityNeighborsQuery.buildCypher(
      { entity_id: "ent_postgres", depth: 2, limit: 50 },
      PROJECT_ID,
    );
    expect(built.cypher).toContain("[*1..2]-");
    expect(built.cypher).toContain("MATCH (root)");
    expect(built.params).toEqual({
      entity_id: "ent_postgres",
      project_id: PROJECT_ID,
      limit: 50,
    });
  });

  it("flattens a returned path into deduplicated nodes + edges", () => {
    const records = [
      mkRecord({
        path_nodes: [
          mkNeoNode({
            identity: "1",
            labels: ["Entity"],
            properties: { name: "Postgres", entity_kind: "Technology" },
          }),
          mkNeoNode({
            identity: "2",
            labels: ["Entity"],
            properties: { name: "pgvector", entity_kind: "Technology" },
          }),
        ],
        path_rels: [mkNeoRel({ type: "MENTIONS", properties: { weight: 0.9 } })],
      }),
    ];
    const out = entityNeighborsQuery.parseResult(records);
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toEqual([
      expect.objectContaining({ source: "Postgres", target: "pgvector", kind: "mentions", weight: 0.9 }),
    ]);
    expect(out.stats?.depth_reached).toBe(1);
  });
});

describe("episode_lineage", () => {
  it("validates uuid episode_id and direction", () => {
    expect(
      episodeLineageQuery.paramSchema.safeParse({ episode_id: "not-a-uuid", direction: "both" }).success,
    ).toBe(false);
    expect(
      episodeLineageQuery.paramSchema.safeParse({ episode_id: EP_A, direction: "both" }).success,
    ).toBe(true);
  });

  it("emits a recursive CTE with both ancestor + descendant branches", () => {
    const built = episodeLineageQuery.buildCypher(
      { episode_id: EP_A, direction: "both", max_depth: 5 },
      PROJECT_ID,
    );
    expect(built.cypher).toContain("with recursive lineage as");
    expect(built.cypher).toContain("'ancestor'");
    expect(built.cypher).toContain("'descendant'");
    expect(built.cypher).toContain("abs(anc.level) < 5");
    expect(built.params).toEqual({ $1: EP_A, $2: PROJECT_ID });
  });

  it("descendants-only omits the ancestor branch", () => {
    const built = episodeLineageQuery.buildCypher(
      { episode_id: EP_A, direction: "descendants", max_depth: 3 },
      PROJECT_ID,
    );
    expect(built.cypher).not.toContain("'ancestor'");
    expect(built.cypher).toContain("'descendant'");
  });

  it("shapes pg rows into ep_-prefixed nodes + supersedes edges", () => {
    const rows = [
      mkRecord({
        id: EP_A,
        name: "Root episode",
        summary: "first version",
        member_count: 1,
        created_at: "2026-05-01T00:00:00.000Z",
        previous_episode_id: null,
        level: 0,
      }),
      mkRecord({
        id: EP_B,
        name: "Newer episode",
        summary: "fork",
        member_count: 2,
        created_at: "2026-05-02T00:00:00.000Z",
        previous_episode_id: EP_A,
        level: 1,
      }),
    ];
    const out = episodeLineageQuery.parseResult(rows);
    expect(out.nodes.map((n) => n.id)).toEqual([`ep_${EP_A}`, `ep_${EP_B}`]);
    expect(out.edges).toEqual([
      expect.objectContaining({
        source: `ep_${EP_B}`,
        target: `ep_${EP_A}`,
        kind: "supersedes",
      }),
    ]);
  });
});

describe("tag_contributors", () => {
  it("validates tag_id is a uuid", () => {
    expect(
      tagContributorsQuery.paramSchema.safeParse({ tag_id: "not-uuid", top_n: 5 }).success,
    ).toBe(false);
    expect(
      tagContributorsQuery.paramSchema.safeParse({ tag_id: TAG_X, top_n: 5 }).success,
    ).toBe(true);
  });

  it("scopes by project_id via $2 bind", () => {
    const built = tagContributorsQuery.buildCypher({ tag_id: TAG_X, top_n: 5 }, PROJECT_ID);
    expect(built.cypher).toContain("m.project_id = $2::uuid");
    expect(built.cypher).toContain("limit 5");
    expect(built.params).toEqual({ $1: TAG_X, $2: PROJECT_ID });
  });

  it("buckets the union'd rows into tag/user/memory nodes", () => {
    const userId = "user-A";
    const memId = "11111111-1111-1111-1111-111111111111";
    const rows = [
      mkRecord({
        kind: "tag",
        id: TAG_X,
        label: "postgres",
        memory_count: null,
        content: null,
        created_at: null,
        owner_user_id: null,
      }),
      mkRecord({
        kind: "user",
        id: userId,
        label: userId,
        memory_count: 3,
        content: null,
        created_at: null,
        owner_user_id: userId,
      }),
      mkRecord({
        kind: "memory",
        id: memId,
        label: "memory preview",
        memory_count: null,
        content: "full content",
        created_at: "2026-05-01T00:00:00.000Z",
        owner_user_id: userId,
      }),
    ];
    const out = tagContributorsQuery.parseResult(rows);
    expect(out.nodes.map((n) => n.id)).toEqual([`tag_${TAG_X}`, `user_${userId}`, `mem_${memId}`]);
    const edgeKinds = new Set(out.edges.map((e) => e.kind));
    expect(edgeKinds).toEqual(new Set(["authored", "tagged_with"]));
  });
});

describe("memory_paths", () => {
  it("clamps max_depth to 1..10", () => {
    expect(
      memoryPathsQuery.paramSchema.safeParse({
        from_memory_id: "a",
        to_memory_id: "b",
        max_depth: 99,
      }).success,
    ).toBe(false);
  });

  it("inlines the depth into shortestPath() and strips mem_ prefixes", () => {
    const built = memoryPathsQuery.buildCypher(
      { from_memory_id: "mem_aaa", to_memory_id: "mem_bbb", max_depth: 4 },
      PROJECT_ID,
    );
    expect(built.cypher).toContain("shortestPath((start)-[*1..4]-(target))");
    expect(built.params).toEqual({
      from_memory_id: "aaa",
      to_memory_id: "bbb",
      project_id: PROJECT_ID,
    });
  });

  it("returns path_exists=false on an empty record set", () => {
    const out = memoryPathsQuery.parseResult([]);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.stats?.path_exists).toBe(false);
  });

  it("flattens the path nodes + rels into the response shape", () => {
    const records = [
      mkRecord({
        path_nodes: [
          mkNeoNode({
            identity: "10",
            labels: ["Memory"],
            properties: { openkt_memory_id: "aaa", name: "memory A" },
          }),
          mkNeoNode({
            identity: "11",
            labels: ["Entity"],
            properties: { openkt_entity_id: "postgres", name: "Postgres" },
          }),
          mkNeoNode({
            identity: "12",
            labels: ["Memory"],
            properties: { openkt_memory_id: "bbb", name: "memory B" },
          }),
        ],
        path_rels: [
          mkNeoRel({ type: "MENTIONS" }),
          mkNeoRel({ type: "MENTIONS" }),
        ],
      }),
    ];
    const out = memoryPathsQuery.parseResult(records);
    expect(out.nodes.map((n) => n.id)).toEqual(["mem_aaa", "ent_postgres", "mem_bbb"]);
    expect(out.edges).toHaveLength(2);
    expect(out.stats?.path_exists).toBe(true);
    expect(out.stats?.depth_reached).toBe(2);
  });
});

describe("entity_centrality", () => {
  it("validates ISO `since` when provided", () => {
    expect(
      entityCentralityQuery.paramSchema.safeParse({ top_n: 10, since: "not-iso" }).success,
    ).toBe(false);
    expect(
      entityCentralityQuery.paramSchema.safeParse({ top_n: 10, since: "2026-05-01T00:00:00.000Z" }).success,
    ).toBe(true);
  });

  it("omits the since clause when no `since` is given", () => {
    const built = entityCentralityQuery.buildCypher({ top_n: 5 }, PROJECT_ID);
    expect(built.cypher).not.toContain("m.created_at");
    expect(built.params).toEqual({ project_id: PROJECT_ID, top_n: 5 });
  });

  it("adds the since clause and a $since param when provided", () => {
    const built = entityCentralityQuery.buildCypher(
      { top_n: 5, since: "2026-05-01T00:00:00.000Z" },
      PROJECT_ID,
    );
    expect(built.cypher).toContain("coalesce(m.created_at, m.openkt_created_at, '') >= $since");
    expect(built.params).toEqual({
      project_id: PROJECT_ID,
      top_n: 5,
      since: "2026-05-01T00:00:00.000Z",
    });
  });

  it("returns nodes carrying mention_count as centrality_score", () => {
    const records = [
      mkRecord({
        node_id: 42,
        entity_key: "postgres",
        label: "Postgres",
        entity_kind: "Technology",
        mention_count: 17,
      }),
    ];
    const out = entityCentralityQuery.parseResult(records);
    expect(out.nodes[0]).toMatchObject({
      id: "ent_postgres",
      type: "entity",
      mention_count: 17,
      centrality_score: 17,
    });
    expect(out.edges).toEqual([]);
  });
});

describe("project_overview", () => {
  it("defaults include to all five kinds", () => {
    const parsed = projectOverviewQuery.paramSchema.parse({});
    expect(new Set(parsed.include)).toEqual(
      new Set(["memories", "episodes", "entities", "tags", "contributors"]),
    );
  });

  it("emits one section per requested kind", () => {
    const built = projectOverviewQuery.buildCypher(
      { include: ["memories", "tags"] },
      PROJECT_ID,
    );
    expect(built.cypher).toContain("'memories'::text");
    expect(built.cypher).toContain("'tags'::text");
    expect(built.cypher).not.toContain("'episodes'::text");
    expect(built.params).toEqual({ $1: PROJECT_ID });
  });

  it("aggregates counts + samples into the response shape", () => {
    const memId = "11111111-1111-1111-1111-111111111111";
    const tagId = "22222222-2222-2222-2222-222222222222";
    const rows = [
      mkRecord({
        kind: "memories",
        sample_kind: "count",
        id: null,
        label: null,
        count: 42,
        created_at: null,
      }),
      mkRecord({
        kind: "memories",
        sample_kind: "sample",
        id: memId,
        label: "memory preview",
        count: null,
        created_at: "2026-05-01T00:00:00.000Z",
      }),
      mkRecord({
        kind: "tags",
        sample_kind: "count",
        id: null,
        label: null,
        count: 7,
        created_at: null,
      }),
      mkRecord({
        kind: "tags",
        sample_kind: "sample",
        id: tagId,
        label: "postgres",
        count: 5,
        created_at: null,
      }),
    ];
    const out = projectOverviewQuery.parseResult(rows);
    const counts = out.stats?.counts as Record<string, number>;
    expect(counts.memories).toBe(42);
    expect(counts.tags).toBe(7);
    expect(out.nodes.find((n) => n.id === `mem_${memId}`)).toBeDefined();
    expect(out.nodes.find((n) => n.id === `tag_${tagId}`)).toBeDefined();
  });
});

describe("read-only guard", () => {
  it("trips when any query builder emits a CREATE/MERGE keyword", async () => {
    const { assertReadOnlyCypher } = await import(
      "../../apps/server/src/modules/graph/queries/types"
    );
    expect(() => assertReadOnlyCypher("MATCH (n) RETURN n")).not.toThrow();
    expect(() => assertReadOnlyCypher("MATCH (n) DELETE n")).toThrow(/read-only guard tripped/);
    expect(() => assertReadOnlyCypher("MERGE (n:Entity) RETURN n")).toThrow();
    expect(() => assertReadOnlyCypher("MATCH (n) SET n.x = 1 RETURN n")).toThrow();
  });
});
