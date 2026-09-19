/**
 * E2E coverage for POST /v1/projects/:project_id/graph/query.
 *
 * What is real:
 *   - GraphQueryController, GraphQueryService whitelist + dispatch,
 *     contract validation, app exception filter, ok envelope.
 *
 * What is mocked:
 *   - SupabaseJwtGuard
 *   - RateLimitGuard (bypassed)
 *   - Neo4jService.isConfigured
 *   - The internal Neo4j read runner (we inject a fake via
 *     setNeo4jRunner) and the Postgres session (setPostgresSession)
 *   - @openkt/auth-authorization.requireProjectAccess — we vary the
 *     return for the project-isolation case.
 */

const mockRequireProjectAccess = jest.fn();

jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireProjectAccess: mockRequireProjectAccess,
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
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import { Observable } from "rxjs";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";
import {
  ForbiddenDomainError,
  NotFoundDomainError,
} from "@openkt/core-errors";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { GraphQueryController } from "../../apps/server/src/modules/graph/controllers/graph-query.controller";
import { GraphQueryService } from "../../apps/server/src/modules/graph/services/graph-query.service";
import { Neo4jService } from "../../apps/server/src/modules/graph/services/neo4j.service";
import { PostgresSession } from "../../apps/server/src/modules/graph/services/postgres-session";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { RateLimitGuard } from "../../apps/server/src/modules/rate-limit/guards/rate-limit.guard";

const PROJECT_A = "00000000-0000-4000-8000-0000000000a1";
const PROJECT_B = "00000000-0000-4000-8000-0000000000b2";
const USER_A = "00000000-0000-4000-8000-0000000000aa";

function fakeActorContext(): ActorContext {
  return {
    principal: {
      type: "user",
      userId: USER_A,
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
    req.requestMetadata = { requestId: "test-request" };
    return next.handle();
  }
}

class FakePostgresSession extends PostgresSession {
  rows: Record<string, unknown>[] = [];
  override async runRead(): Promise<Record<string, unknown>[]> {
    return this.rows;
  }
}

describe("GraphQueryController POST /projects/:project_id/graph/query (e2e)", () => {
  let app: INestApplication;
  let svc: GraphQueryService;
  const neo4jMock = {
    isConfigured: jest.fn().mockReturnValue(true),
  };
  const stubBypassGuard = { canActivate: () => true };

  beforeAll(async () => {
    @Module({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [GraphQueryController],
      providers: [
        GraphQueryService,
        { provide: Neo4jService, useValue: neo4jMock },
        { provide: APP_INTERCEPTOR, useClass: StubActorContextInterceptor },
      ],
    })
    class TestGraphQueryModule {}

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestGraphQueryModule],
    })
      .overrideGuard(SupabaseJwtGuard)
      .useValue(stubBypassGuard)
      .overrideGuard(RateLimitGuard)
      .useValue(stubBypassGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(json());
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    svc = moduleRef.get(GraphQueryService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockRequireProjectAccess.mockReset();
    mockRequireProjectAccess.mockImplementation(async (_ctx, projectId: string) => ({
      projectId,
      orgId: null,
      ownerUserId: USER_A,
      visibility: "personal",
      role: "owner",
    }));
    neo4jMock.isConfigured.mockReturnValue(true);
  });

  it("returns 400 with code=validation_error and message='unknown_query' for unknown queries", async () => {
    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_A}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({ query: "totally_bogus", params: {} })
      .expect(400);

    expect(res.body).toMatchObject({
      data: null,
      error: expect.objectContaining({
        code: "validation_error",
        message: "unknown_query",
      }),
    });
  });

  it("returns 400 invalid_params when params are wrong shape", async () => {
    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_A}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({ query: "entity_neighbors", params: { depth: 99 } })
      .expect(400);

    expect(res.body.error).toMatchObject({
      code: "validation_error",
      message: "invalid_params",
    });
  });

  it("returns 200 with nodes / edges / stats / took_ms for a valid query", async () => {
    svc.setNeo4jRunner({
      runRead: async () => [
        {
          keys: ["path_nodes", "path_rels"],
          get: (key: string) => {
            if (key === "path_nodes") {
              return [
                {
                  identity: "1",
                  labels: ["Entity"],
                  properties: { name: "Postgres" },
                },
                {
                  identity: "2",
                  labels: ["Entity"],
                  properties: { name: "pgvector" },
                },
              ];
            }
            return [{ type: "MENTIONS", properties: { weight: 0.91 } }];
          },
        },
      ],
    });
    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_A}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({
        query: "entity_neighbors",
        params: { entity_id: "Postgres", depth: 1, limit: 10 },
      })
      .expect(200);

    expect(res.body.data).toMatchObject({
      query: "entity_neighbors",
      nodes: expect.any(Array),
      edges: expect.any(Array),
      stats: expect.objectContaining({
        node_count: expect.any(Number),
        edge_count: expect.any(Number),
      }),
      took_ms: expect.any(Number),
    });
  });

  it("returns 503 graph_unavailable when neo4j is unconfigured", async () => {
    neo4jMock.isConfigured.mockReturnValueOnce(false);
    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_A}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({
        query: "entity_neighbors",
        params: { entity_id: "Postgres" },
      })
      .expect(503);

    // The AppExceptionFilter unwraps HttpException payloads with a
    // top-level { code, message } shape into the envelope: code lands
    // at `error.code` and the remainder of the payload (here, our
    // service-supplied `details: { query, backend, reason }`) is nested
    // under `error.details`. UI reads `error.code` to differentiate
    // 503 reasons.
    expect(res.body.error.code).toBe("graph_unavailable");
    const details = res.body.error.details as Record<string, unknown>;
    expect(details).toBeDefined();
  });

  it("rejects with a non-200 envelope when project access is denied (project isolation)", async () => {
    // Project A's JWT requests a query for project B → access policy throws.
    mockRequireProjectAccess.mockImplementationOnce(async (_ctx, projectId: string) => {
      if (projectId === PROJECT_B) throw new ForbiddenDomainError("not a member");
      return {
        projectId,
        orgId: null,
        ownerUserId: USER_A,
        visibility: "personal",
        role: "owner",
      };
    });
    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_B}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({ query: "entity_neighbors", params: { entity_id: "x" } })
      .expect(403);

    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 404 when requireProjectAccess says project not found (isolation by 404)", async () => {
    mockRequireProjectAccess.mockImplementationOnce(async () => {
      throw new NotFoundDomainError("project");
    });
    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_A}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({ query: "entity_neighbors", params: { entity_id: "x" } })
      .expect(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("rejects non-uuid project_id with a 400 envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/projects/not-a-uuid/graph/query")
      .set("Authorization", "Bearer ignored")
      .send({ query: "entity_neighbors", params: { entity_id: "x" } })
      .expect(400);
    expect(res.body.error.code).toBeDefined();
  });

  it("dispatches a postgres-backed query through PostgresSession", async () => {
    const pg = new FakePostgresSession();
    pg.rows = [
      {
        kind: "memories",
        sample_kind: "count",
        id: null,
        label: null,
        count: 3,
        created_at: null,
      },
    ];
    svc.setPostgresSession(pg);

    const res = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_A}/graph/query`)
      .set("Authorization", "Bearer ignored")
      .send({ query: "project_overview", params: { include: ["memories"] } })
      .expect(200);
    expect(res.body.data.stats.counts.memories).toBe(3);
  });
});
