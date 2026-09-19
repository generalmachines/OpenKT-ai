/**
 * E2E test for GET /v1/projects/:project_id/graph.
 *
 * Validates the full Nest request/response cycle for the graph path.
 * Routing → guard (overridden) → controller → GraphService → repo +
 * Neo4j (both mocked) → response shaper.
 *
 * What is real:
 *   - GraphController, GraphService, contract validation, ok envelope.
 *
 * What is mocked:
 *   - SupabaseJwtGuard
 *   - GraphRepository  (so we don't need a live pg/pgvector)
 *   - Neo4jService     (so we don't need a live Neo4j)
 *   - @openkt/auth-authorization.requireProjectAccess
 */
jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireProjectAccess: jest.fn().mockResolvedValue({
      projectId: "00000000-0000-4000-8000-000000000001",
      orgId: null,
      ownerUserId: "00000000-0000-4000-8000-0000000000aa",
      visibility: "personal",
      role: "owner",
    }),
  };
});

import {
  type CallHandler,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  Module,
  type NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import request from "supertest";
import { Observable } from "rxjs";

import type { ActorContext } from "@openkt/core-context";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { GraphController } from "../../apps/server/src/modules/graph/controllers/graph.controller";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { GraphRepository } from "../../apps/server/src/modules/graph/services/graph.repository";
import { GraphService } from "../../apps/server/src/modules/graph/services/graph.service";
import { Neo4jService } from "../../apps/server/src/modules/graph/services/neo4j.service";
import { RateLimitService } from "../../apps/server/src/modules/rate-limit/services/rate-limit.service";

// Valid UUID v4 — version nibble (index 14) is `4`, variant nibble
// (index 19) is `8|9|a|b`. The route param zod schema enforces v4.
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const MEM_A = "00000000-0000-4000-8000-00000000a001";
const MEM_B = "00000000-0000-4000-8000-00000000a002";
const EP_X = "00000000-0000-4000-8000-00000000b001";

function fakeActorContext(): ActorContext {
  return {
    principal: {
      type: "user",
      userId: USER_ID,
      email: "e2e@test.local",
      displayName: "e2e",
      authSource: "supabase-jwt",
      tokenId: null,
      serviceName: null,
    },
    request: {
      requestId: "test-request",
      surface: "cli",
      userAgent: "jest",
      ip: "127.0.0.1",
      origin: null,
    } as unknown as ActorContext["request"],
    sb: {} as ActorContext["sb"],
    admin: () => ({}) as ReturnType<ActorContext["admin"]>,
  };
}

@Injectable()
class StubActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    req.actorContext = fakeActorContext();
    return next.handle();
  }
}

describe("GraphController GET /projects/:project_id/graph (e2e)", () => {
  let app: INestApplication;
  const stubBypassGuard = { canActivate: () => true };

  const repoMock = {
    getProjectFocus: jest.fn().mockResolvedValue({
      id: PROJECT_ID,
      org_id: null,
      owner_user_id: USER_ID,
    }),
    listMemories: jest.fn().mockResolvedValue([
      {
        id: MEM_A,
        content: "memory A — postgres + pgvector decision",
        kind: "decision",
        confidence: 0.9,
        owner_user_id: USER_ID,
        archived: false,
        created_at: "2026-05-01T10:00:00.000Z",
      },
      {
        id: MEM_B,
        content: "memory B — memmachine layering note",
        kind: "note",
        confidence: 0.7,
        owner_user_id: USER_ID,
        archived: false,
        created_at: "2026-05-01T11:00:00.000Z",
      },
    ]),
    listEpisodes: jest.fn().mockResolvedValue([
      {
        id: EP_X,
        name: "Postgres adoption cluster",
        summary: "Why we picked Postgres + pgvector over Pinecone",
        member_count: 2,
        created_at: "2026-05-01T11:30:00.000Z",
      },
    ]),
    listEpisodeMemoryEdges: jest.fn().mockResolvedValue([
      { episode_id: EP_X, memory_id: MEM_A, similarity_at_join: 0.95 },
      { episode_id: EP_X, memory_id: MEM_B, similarity_at_join: 0.88 },
    ]),
    listSimilarityEdges: jest.fn().mockResolvedValue([
      { source: MEM_A, target: MEM_B, similarity: 0.92 },
    ]),
  };

  const neo4jMock = {
    isConfigured: jest.fn().mockReturnValue(true),
    listEntitiesForProject: jest.fn().mockResolvedValue([
      {
        id: "ent_postgres",
        label: "Postgres",
        entityKind: "Technology",
        neo4jNodeId: "42",
      },
    ]),
    listMentionEdgesForProject: jest.fn().mockResolvedValue([
      { source: `mem_${MEM_A}`, target: "ent_postgres", weight: 0.91 },
    ]),
    audit: jest.fn(),
  };

  beforeAll(async () => {
    @Module({
      controllers: [GraphController],
      providers: [
        GraphService,
        { provide: GraphRepository, useValue: repoMock },
        { provide: Neo4jService, useValue: neo4jMock },
        {
          provide: RateLimitService,
          useValue: { acquire: jest.fn().mockResolvedValue({ allowed: true, remaining: 999 }) },
        },
        { provide: APP_INTERCEPTOR, useClass: StubActorContextInterceptor },
      ],
    })
    class TestGraphModule {}

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestGraphModule],
    })
      .overrideGuard(SupabaseJwtGuard)
      .useValue(stubBypassGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(json());
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns memories + episodes + entities and the four edge kinds", async () => {
    const res = await request(app.getHttpServer())
      .get(`/projects/${PROJECT_ID}/graph`)
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    const body = res.body.data;
    expect(body.stats.neo4j_available).toBe(true);
    expect(body.stats.node_count).toBe(4);

    const nodeTypes = new Set(body.nodes.map((node: { type: string }) => node.type));
    expect(nodeTypes).toEqual(new Set(["memory", "episode", "entity"]));

    const edgeKinds = new Set(body.edges.map((edge: { kind: string }) => edge.kind));
    expect(edgeKinds).toEqual(new Set(["contributes_to", "similar", "mentions"]));

    // Memory count on the entity node should reflect mentions edges.
    const entityNode = body.nodes.find(
      (node: { type: string; id: string }) => node.type === "entity",
    );
    expect(entityNode).toMatchObject({
      id: "ent_postgres",
      memory_count: 1,
    });

    expect(body.legend.node_types).toEqual(["memory", "episode", "entity"]);
    expect(body.legend.edge_kinds).toEqual(
      expect.arrayContaining(["contributes_to", "supersedes", "mentions", "similar"]),
    );
  });

  it("omits entity nodes/edges when neo4j is unconfigured", async () => {
    neo4jMock.isConfigured.mockReturnValueOnce(false);

    const res = await request(app.getHttpServer())
      .get(`/projects/${PROJECT_ID}/graph`)
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    const body = res.body.data;
    expect(body.stats.neo4j_available).toBe(false);
    const types = new Set(body.nodes.map((node: { type: string }) => node.type));
    expect(types.has("entity")).toBe(false);
    const kinds = new Set(body.edges.map((edge: { kind: string }) => edge.kind));
    expect(kinds.has("mentions")).toBe(false);
  });

  it("honors include=memories,episodes and skips entities + similarity", async () => {
    neo4jMock.isConfigured.mockReturnValueOnce(true);

    const res = await request(app.getHttpServer())
      .get(`/projects/${PROJECT_ID}/graph?include=memories,episodes&limit=10`)
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    const body = res.body.data;
    const types = new Set(body.nodes.map((node: { type: string }) => node.type));
    expect(types).toEqual(new Set(["memory", "episode"]));
    const kinds = new Set(body.edges.map((edge: { kind: string }) => edge.kind));
    // contributes_to is the only edge that should survive memories+episodes.
    expect(kinds).toEqual(new Set(["contributes_to"]));
  });

  it("rejects a non-uuid project_id with a 400 envelope", async () => {
    const res = await request(app.getHttpServer())
      .get("/projects/not-a-uuid/graph")
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(400);

    expect(res.body).toMatchObject({
      data: null,
      error: expect.objectContaining({
        code: expect.any(String),
        message: expect.any(String),
      }),
    });
  });
});
