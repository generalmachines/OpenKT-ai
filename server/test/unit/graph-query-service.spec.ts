// Unit tests for the dispatcher (GraphQueryService) — the controller-
// side path through whitelist enforcement, project_id binding, backend
// dispatch, and error mapping.
//
// We mock the auth-authorization layer at the module-mock level so we
// can simulate both "access granted" and "access denied" without a
// live Supabase / pg.

const mockRequireProjectAccess = jest.fn();

jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireProjectAccess: mockRequireProjectAccess,
  };
});

import { HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ActorContext } from "@openkt/core-context";
import {
  ForbiddenDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";

import { GraphQueryService } from "../../apps/server/src/modules/graph/services/graph-query.service";
import type { Neo4jService } from "../../apps/server/src/modules/graph/services/neo4j.service";
import { PostgresSession } from "../../apps/server/src/modules/graph/services/postgres-session";

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_PROJECT_ID = "00000000-0000-0000-0000-000000000099";

function fakeContext(): ActorContext {
  return {
    principal: {
      type: "user",
      userId: "00000000-0000-0000-0000-0000000000aa",
      email: "u@test",
      displayName: "u",
      authSource: "supabase-jwt",
      tokenId: null,
      serviceName: null,
    },
    request: {} as ActorContext["request"],
    sb: {} as ActorContext["sb"],
    admin: () => ({}) as ReturnType<ActorContext["admin"]>,
  };
}

function fakeNeo4j(configured: boolean): Neo4jService {
  return {
    isConfigured: () => configured,
  } as unknown as Neo4jService;
}

function fakeConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

class FakePostgresSession extends PostgresSession {
  rows: Record<string, unknown>[] = [];
  lastSql: string | null = null;
  lastParams: unknown[] | null = null;
  override async runRead(sqlText: string, params: unknown[]) {
    this.lastSql = sqlText;
    this.lastParams = params;
    return this.rows;
  }
}

beforeEach(() => {
  mockRequireProjectAccess.mockReset();
  mockRequireProjectAccess.mockResolvedValue({
    projectId: PROJECT_ID,
    orgId: null,
    ownerUserId: "00000000-0000-0000-0000-0000000000aa",
    visibility: "personal",
    role: "owner",
  });
});

describe("GraphQueryService — whitelist + dispatch", () => {
  it("rejects unknown query names with ValidationDomainError 'unknown_query'", async () => {
    const svc = new GraphQueryService(fakeNeo4j(true), fakeConfig());
    await expect(
      svc.execute(fakeContext(), PROJECT_ID, { query: "not-a-real-query", params: {} }),
    ).rejects.toBeInstanceOf(ValidationDomainError);
    await expect(
      svc.execute(fakeContext(), PROJECT_ID, { query: "not-a-real-query", params: {} }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "unknown_query",
    });
  });

  it("rejects invalid per-query params with 'invalid_params'", async () => {
    const svc = new GraphQueryService(fakeNeo4j(true), fakeConfig());
    await expect(
      svc.execute(fakeContext(), PROJECT_ID, {
        query: "entity_neighbors",
        // missing entity_id, depth out of range
        params: { depth: 99 },
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "invalid_params",
    });
  });

  it("rejects requests when requireProjectAccess throws", async () => {
    mockRequireProjectAccess.mockRejectedValueOnce(new ForbiddenDomainError("forbidden"));
    const svc = new GraphQueryService(fakeNeo4j(true), fakeConfig());
    await expect(
      svc.execute(fakeContext(), OTHER_PROJECT_ID, {
        query: "entity_neighbors",
        params: { entity_id: "x" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenDomainError);
  });

  it("returns 503 graph_unavailable when neo4j is unconfigured", async () => {
    const svc = new GraphQueryService(fakeNeo4j(false), fakeConfig());
    try {
      await svc.execute(fakeContext(), PROJECT_ID, {
        query: "entity_neighbors",
        params: { entity_id: "x" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = (err as HttpException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe("graph_unavailable");
    }
  });

  it("dispatches postgres-backed queries through PostgresSession and parses rows", async () => {
    const svc = new GraphQueryService(fakeNeo4j(true), fakeConfig());
    const pg = new FakePostgresSession();
    pg.rows = [
      {
        kind: "memories",
        sample_kind: "count",
        id: null,
        label: null,
        count: 5,
        created_at: null,
      },
    ];
    svc.setPostgresSession(pg);

    const result = await svc.execute(fakeContext(), PROJECT_ID, {
      query: "project_overview",
      params: { include: ["memories"] },
    });
    expect(pg.lastParams).toEqual([PROJECT_ID]);
    expect(pg.lastSql).toContain("'memories'::text");
    expect(result.query).toBe("project_overview");
    expect((result.stats as Record<string, unknown>).counts).toMatchObject({ memories: 5 });
    expect(typeof result.took_ms).toBe("number");
  });

  it("dispatches neo4j-backed queries through the injected runner", async () => {
    const svc = new GraphQueryService(fakeNeo4j(true), fakeConfig());
    const captured: { cypher: string | null; params: Record<string, unknown> | null } = {
      cypher: null,
      params: null,
    };
    svc.setNeo4jRunner({
      runRead: async (cypher, params) => {
        captured.cypher = cypher;
        captured.params = params;
        return [
          {
            keys: ["node_id", "entity_key", "label", "entity_kind", "mention_count"],
            get: (key: string) =>
              ({
                node_id: 7,
                entity_key: "postgres",
                label: "Postgres",
                entity_kind: "Technology",
                mention_count: 12,
              })[key],
          },
        ];
      },
    });

    const result = await svc.execute(fakeContext(), PROJECT_ID, {
      query: "entity_centrality",
      params: { top_n: 5 },
    });
    expect(captured.params).toMatchObject({ project_id: PROJECT_ID, top_n: 5 });
    expect(result.nodes[0]).toMatchObject({ id: "ent_postgres", mention_count: 12 });
  });

  it("overrides any client-supplied project_id with the path param", async () => {
    // The caller can stuff `project_id` into params; the dispatcher
    // ignores it and binds the URL's projectId instead.
    const svc = new GraphQueryService(fakeNeo4j(true), fakeConfig());
    const captured: { params: Record<string, unknown> | null } = { params: null };
    svc.setNeo4jRunner({
      runRead: async (_cypher, params) => {
        captured.params = params;
        return [];
      },
    });
    await svc.execute(fakeContext(), PROJECT_ID, {
      query: "entity_neighbors",
      params: { entity_id: "ent_x", project_id: OTHER_PROJECT_ID },
    });
    expect(captured.params?.project_id).toBe(PROJECT_ID);
  });

  it("availableQueries() returns the static name list", () => {
    expect(new Set(GraphQueryService.availableQueries())).toEqual(
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
});
