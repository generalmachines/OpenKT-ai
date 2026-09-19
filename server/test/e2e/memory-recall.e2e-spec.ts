/**
 * E2E test for Phase 4.4 — POST /memories/recall.
 *
 * Goal: validate the full Nest request/response cycle for the recall
 * path. The test goes through routing → guard (overridden to bypass
 * Supabase JWT verification) → controller → MemoryRecallService →
 * repository (mocked) → response shaper. This catches integration
 * failures unit tests miss while staying runnable in CI without a live
 * Supabase.
 *
 * What is real:
 *   - MemoriesController, MemoryRecallService, the controller
 *     parameter pipes (zod validation in zod-parse), the
 *     pagedResponse envelope, the request-id middleware, the
 *     ActorContext param decorator wiring.
 *
 * What is mocked:
 *   - SupabaseJwtGuard (overridden to inject a synthetic ActorContext)
 *   - MemoryRepository (search + recall stubbed)
 *   - ProjectScopeService (resolveProjectIdOrSlug + workspaceRing stubbed)
 *   - @openkt/auth-authorization (requireProjectAccess stubbed via
 *     jest.mock so the test does not need a real Supabase admin client)
 *
 * If you change the recall payload contract, the controller route, or
 * the recall service signature, this test should fail loudly. That is
 * the contract this test guards.
 */
jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireProjectAccess: jest.fn().mockResolvedValue({
      projectId: "00000000-0000-0000-0000-000000000001",
      orgId: null,
      role: "admin",
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
import { MemoriesController } from "../../apps/server/src/modules/memory/controllers/memories.controller";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { AuditService } from "../../apps/server/src/modules/audit/services/audit.service";
import { RateLimitService } from "../../apps/server/src/modules/rate-limit/services/rate-limit.service";
import { KnowledgeRepository } from "../../apps/server/src/modules/memory/repositories/knowledge.repository";
import { MemoryRepository } from "../../apps/server/src/modules/memory/repositories/memory.repository";
import { DrizzleOutboxRepository } from "../../apps/server/src/modules/memory/repositories/drizzle-outbox.repository";
import { MemoryCommandsApplicationService } from "../../apps/server/src/modules/memory/services/memory-commands.application.service";
import { MemoryAnswerService } from "../../apps/server/src/modules/memory/services/memory-answer.service";
import { MemoryEnhancementService } from "../../apps/server/src/modules/memory/services/memory-enhancement.service";
import { MemoryOutboxService } from "../../apps/server/src/modules/memory/services/memory-outbox.service";
import { MemoryQueriesApplicationService } from "../../apps/server/src/modules/memory/services/memory-queries.application.service";
import { MemoryRecallService } from "../../apps/server/src/modules/memory/services/memory-recall.service";
import { MEMORY_ENGINE } from "../../apps/server/src/modules/memory/services/memory-engine";
import { ProjectScopeService } from "../../apps/server/src/modules/projects/services/project-scope.service";
import { SessionRepository } from "../../apps/server/src/modules/sessions/repositories/session.repository";
import { AccessScopeService } from "../../apps/server/src/modules/access/services/access-scope.service";

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const MEMORY_ID = "00000000-0000-0000-0000-000000000abc";
const USER_ID = "00000000-0000-0000-0000-0000000000aa";

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

/**
 * Mirrors the real RequestMetadataInterceptor + auth guard side-effect:
 * stamps an actor context onto the request so @ActorContextParam works.
 * Avoids pulling the full AuthModule (which needs env/Supabase config).
 */
@Injectable()
class StubActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    req.actorContext = fakeActorContext();
    return next.handle();
  }
}

const recallReturn = {
  data: [
    {
      id: MEMORY_ID,
      org_id: null,
      project_id: PROJECT_ID,
      owner: { user_id: USER_ID, email: "e2e@test.local", display_name: "e2e" },
      content: "the recall result",
      kind: "note",
      category: null,
      tags: [],
      visibility: "project",
      confidence: 0.9,
      importance: 0.5,
      decay_lambda: 0.05,
      importance_at: "2026-04-28T00:00:00.000Z",
      access_count: 0,
      last_accessed_at: null,
      source_refs: [],
      superseded_by: null,
      archived: false,
      created_at: "2026-04-28T00:00:00.000Z",
      updated_at: "2026-04-28T00:00:00.000Z",
      project: { id: PROJECT_ID, slug: "p", name: "p", visibility: "personal" },
      similarity: 0.42,
      source_scope: "primary",
      effective_importance: 0.5,
    },
  ],
  meta: { query_ms: 7 },
};

describe("MemoriesController POST /memories/recall (e2e)", () => {
  let app: INestApplication;
  const memoryRepoMock = {
    logAccessBatch: jest.fn(),
    // Recall now warms a cached-neighbors table before delegating to
    // the engine. The cache is keyed on (project_id, memory_id) and
    // refreshed every 24h; tests stub it out as a no-op.
    ensureNeighborsFresh: jest.fn().mockResolvedValue(undefined),
  };
  const memoryEngineMock = {
    remember: jest.fn(),
    forget: jest.fn(),
    search: jest.fn().mockResolvedValue({
      data: recallReturn.data,
      meta: {
        total_matched: 1,
        mode: "hybrid",
        vector_weight: 0.6,
        embedding_model: "test",
        next_cursor: null,
        query_ms: 5,
        workspace_weight: 0.4,
        workspace_size: 0,
      },
    }),
    recall: jest.fn().mockResolvedValue(recallReturn),
  };
  const projectScopeMock = {
    resolveProjectIdOrSlug: jest.fn().mockResolvedValue(PROJECT_ID),
    workspaceRing: jest.fn().mockResolvedValue([]),
  };
  const sessionRepoMock = {
    touchActivity: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue(null),
  };
  const accessScopeMock = {
    visibleScope: jest.fn().mockResolvedValue({ projectIds: [PROJECT_ID], sessionIds: [] }),
  };
  const stubBypassGuard = { canActivate: () => true };

  @Module({
    controllers: [MemoriesController],
    providers: [
      MemoryRecallService,
      MemoryQueriesApplicationService,
      MemoryCommandsApplicationService,
      MemoryOutboxService,
      { provide: MemoryAnswerService, useValue: { answer: jest.fn() } },
      { provide: MemoryEnhancementService, useValue: { enhance: jest.fn() } },
      // synthesize-on-save (8e037bf) — recall test doesn't hit the save
      // path, so a no-op stub suffices.
      {
        provide: require("../../apps/server/src/modules/memory/services/memory-synthesis.service").MemorySynthesisService,
        useValue: { synthesizeOnSave: jest.fn().mockResolvedValue({ action: "create" }) },
      },
      { provide: MemoryRepository, useValue: memoryRepoMock },
      {
        provide: KnowledgeRepository,
        useValue: {
          listForProjectByTags: jest.fn().mockResolvedValue([]),
          getById: jest.fn(),
        },
      },
      { provide: MEMORY_ENGINE, useValue: memoryEngineMock },
      { provide: DrizzleOutboxRepository, useValue: { enqueue: jest.fn() } },
      { provide: ProjectScopeService, useValue: projectScopeMock },
      { provide: SessionRepository, useValue: sessionRepoMock },
      { provide: AccessScopeService, useValue: accessScopeMock },
      { provide: AuditService, useValue: { write: jest.fn().mockResolvedValue(undefined) } },
      {
        provide: RateLimitService,
        useValue: { acquire: jest.fn().mockResolvedValue({ allowed: true, remaining: 999 }) },
      },
      { provide: APP_INTERCEPTOR, useClass: StubActorContextInterceptor },
    ],
  })
  class TestMemoryModule {}

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestMemoryModule],
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

  it("returns paged envelope with the recall row + meta", async () => {
    const res = await request(app.getHttpServer())
      .post("/memories/recall")
      .send({
        project_id: PROJECT_ID,
        query: "anything",
        limit: 5,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    expect(res.body).toMatchObject({
      data: [
        expect.objectContaining({
          id: MEMORY_ID,
          project_id: PROJECT_ID,
          similarity: 0.42,
        }),
      ],
      error: null,
      meta: expect.objectContaining({ query_ms: 7 }),
    });

    expect(projectScopeMock.resolveProjectIdOrSlug).toHaveBeenCalledWith(
      expect.any(Object),
      PROJECT_ID,
    );
    expect(projectScopeMock.workspaceRing).toHaveBeenCalledWith(
      expect.any(Object),
      PROJECT_ID,
    );
    expect(memoryEngineMock.search).toHaveBeenCalledTimes(1);
    expect(memoryEngineMock.recall).toHaveBeenCalledTimes(1);
  });

  it("rejects payload missing required limits with a 400 envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/memories/recall")
      .send({ vector_weight: 99 }) // outside [0,1]
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
