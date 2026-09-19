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
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { MemoryQueriesApplicationService } from "../../apps/server/src/modules/memory/services/memory-queries.application.service";
import { PrimeController } from "../../apps/server/src/modules/prime/controllers/prime.controller";
import { PrimeApplicationService } from "../../apps/server/src/modules/prime/services/prime-application.service";
import { ProjectsApplicationService } from "../../apps/server/src/modules/projects/services/projects-application.service";
import { ProjectScopeService } from "../../apps/server/src/modules/projects/services/project-scope.service";

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-0000000000aa";

type TableResult =
  | { data: unknown; error: { message: string } | null }
  | (() => Promise<{ data: unknown; error: { message: string } | null }>);

let currentContext: ActorContext;

function fakeAdminClient(results: Record<string, TableResult>) {
  return {
    from(table: string) {
      const resolve = async () => {
        const entry = results[table];
        if (!entry) {
          return { data: null, error: null };
        }
        return typeof entry === "function" ? entry() : entry;
      };

      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return resolve();
        },
        maybeSingle() {
          return resolve();
        },
      };
    },
  };
}

function makeActorContext(results: Record<string, TableResult>): ActorContext {
  return {
    principal: {
      type: "user",
      userId: USER_ID,
      email: "prime@test.local",
      displayName: "prime",
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
    admin: () =>
      fakeAdminClient(results) as unknown as ReturnType<ActorContext["admin"]>,
  };
}

@Injectable()
class StubActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    req.actorContext = currentContext;
    return next.handle();
  }
}

describe("PrimeController POST /prime (e2e)", () => {
  let app: INestApplication;

  const projectScopeMock = {
    resolveProjectIdOrSlug: jest.fn(),
  };
  const projectsApplicationServiceMock = {
    getById: jest.fn(),
  };
  const memoryQueriesApplicationServiceMock = {
    list: jest.fn(),
    categorized: jest.fn(),
  };
  const stubBypassGuard = { canActivate: () => true };

  @Module({
    controllers: [PrimeController],
    providers: [
      PrimeApplicationService,
      { provide: ProjectScopeService, useValue: projectScopeMock },
      { provide: ProjectsApplicationService, useValue: projectsApplicationServiceMock },
      {
        provide: MemoryQueriesApplicationService,
        useValue: memoryQueriesApplicationServiceMock,
      },
      { provide: APP_INTERCEPTOR, useClass: StubActorContextInterceptor },
    ],
  })
  class TestPrimeModule {}

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestPrimeModule],
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

  beforeEach(() => {
    jest.clearAllMocks();
    projectScopeMock.resolveProjectIdOrSlug.mockResolvedValue(PROJECT_ID);
    projectsApplicationServiceMock.getById.mockResolvedValue({
      id: PROJECT_ID,
      slug: "openkt",
      name: "OpenKT",
      visibility: "personal",
      orgId: null,
      ownerUserId: USER_ID,
      viewerRole: "owner",
    });
    memoryQueriesApplicationServiceMock.list.mockResolvedValue({
      data: [
        {
          id: "00000000-0000-0000-0000-0000000000bb",
          content: "Ship the migration through the API.",
          kind: "decision",
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the composed prime payload", async () => {
    currentContext = makeActorContext({});

    const res = await request(app.getHttpServer())
      .post("/prime")
      .send({
        project_id: "openkt",
        with_briefing: true,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(201);

    expect(res.body).toMatchObject({
      data: {
        project: expect.objectContaining({ id: PROJECT_ID, viewerRole: "owner" }),
        memories: [
          expect.objectContaining({
            content: "Ship the migration through the API.",
          }),
        ],
        reconciliation: {
          pending: 0,
          applied: 0,
        },
        briefing: null,
      },
      error: null,
      meta: null,
    });

    expect(projectScopeMock.resolveProjectIdOrSlug).toHaveBeenCalledWith(
      expect.any(Object),
      "openkt",
    );
    expect(projectsApplicationServiceMock.getById).toHaveBeenCalledWith(
      expect.any(Object),
      PROJECT_ID,
    );
    expect(memoryQueriesApplicationServiceMock.list).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        project_id: PROJECT_ID,
        limit: 50,
      }),
    );
  });

  it("returns categorized memories when with_categorized=true", async () => {
    currentContext = makeActorContext({});
    memoryQueriesApplicationServiceMock.categorized.mockResolvedValueOnce({
      decision: [
        {
          id: "00000000-0000-0000-0000-0000000000d1",
          content: "chose drizzle over prisma",
          kind: "decision",
          importance: 0.9,
        },
      ],
      "anti-pattern": [
        {
          id: "00000000-0000-0000-0000-0000000000a1",
          content: "never delete branches without per-branch approval",
          kind: "anti-pattern",
          importance: 0.85,
        },
      ],
    });

    const res = await request(app.getHttpServer())
      .post("/prime")
      .send({
        project_id: PROJECT_ID,
        with_categorized: true,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(201);

    expect(res.body.data.categorized).toEqual({
      decision: [
        expect.objectContaining({ content: "chose drizzle over prisma" }),
      ],
      "anti-pattern": [
        expect.objectContaining({
          content: "never delete branches without per-branch approval",
        }),
      ],
    });
    expect(memoryQueriesApplicationServiceMock.categorized).toHaveBeenCalledWith(
      expect.any(Object),
      PROJECT_ID,
      ["decision", "anti-pattern", "incident", "pattern", "context"],
      5,
    );
  });

  it("omits categorized field when with_categorized is not set (backward compat)", async () => {
    currentContext = makeActorContext({});

    const res = await request(app.getHttpServer())
      .post("/prime")
      .send({
        project_id: PROJECT_ID,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(201);

    expect(res.body.data).not.toHaveProperty("categorized");
    expect(memoryQueriesApplicationServiceMock.categorized).not.toHaveBeenCalled();
  });

  it("falls open when categorized read throws — omits the field rather than failing the prime call", async () => {
    currentContext = makeActorContext({});
    memoryQueriesApplicationServiceMock.categorized.mockRejectedValueOnce(
      new Error("categorized read failed"),
    );

    const res = await request(app.getHttpServer())
      .post("/prime")
      .send({
        project_id: PROJECT_ID,
        with_categorized: true,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(201);

    expect(res.body.data).not.toHaveProperty("categorized");
    expect(res.body.data.memories).toHaveLength(1);
  });

  it("degrades optional reads to empty arrays and null briefing", async () => {
    currentContext = makeActorContext({});
    memoryQueriesApplicationServiceMock.list.mockRejectedValueOnce(
      new Error("memory list failed"),
    );

    const res = await request(app.getHttpServer())
      .post("/prime")
      .send({
        project_id: PROJECT_ID,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(201);

    expect(res.body).toMatchObject({
      data: {
        project: expect.objectContaining({ id: PROJECT_ID }),
        memories: [],
        reconciliation: {
          pending: 0,
          applied: 0,
        },
        briefing: null,
      },
      error: null,
      meta: null,
    });
  });
});
