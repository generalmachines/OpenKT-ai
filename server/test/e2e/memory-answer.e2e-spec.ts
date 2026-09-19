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
import { LlmGatewayService } from "@openkt/platform-llm";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { MemoriesController } from "../../apps/server/src/modules/memory/controllers/memories.controller";
import { MemoryAnswerService } from "../../apps/server/src/modules/memory/services/memory-answer.service";
import { MemoryEnhancementService } from "../../apps/server/src/modules/memory/services/memory-enhancement.service";
import { MemoryCommandsApplicationService } from "../../apps/server/src/modules/memory/services/memory-commands.application.service";
import { MemoryQueriesApplicationService } from "../../apps/server/src/modules/memory/services/memory-queries.application.service";
import { MemoryRecallService } from "../../apps/server/src/modules/memory/services/memory-recall.service";
import { RateLimitService } from "../../apps/server/src/modules/rate-limit/services/rate-limit.service";

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

@Injectable()
class StubActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    req.actorContext = fakeActorContext();
    return next.handle();
  }
}

const recallResult = {
  data: [
    {
      id: MEMORY_ID,
      content: "We deploy on Tuesdays after QA sign-off.",
      kind: "decision",
      similarity: 0.92,
    },
    {
      id: "00000000-0000-0000-0000-000000000abd",
      content: "Ops owns the rollback checklist.",
      kind: "context",
      similarity: 0.63,
    },
  ],
  meta: { query_ms: 11 },
};

describe("MemoriesController POST /memories/answer (e2e)", () => {
  let app: INestApplication;

  const memoryRecallServiceMock = {
    recall: jest.fn(),
  };
  const llmGatewayMock = {
    tryGenerateObject: jest.fn(),
  };
  const stubBypassGuard = { canActivate: () => true };

  @Module({
    controllers: [MemoriesController],
    providers: [
      MemoryAnswerService,
      { provide: MemoryCommandsApplicationService, useValue: { create: jest.fn() } },
      { provide: MemoryQueriesApplicationService, useValue: { list: jest.fn(), get: jest.fn(), accessSummary: jest.fn(), search: jest.fn() } },
      { provide: MemoryRecallService, useValue: memoryRecallServiceMock },
      { provide: MemoryEnhancementService, useValue: { enhance: jest.fn() } },
      { provide: LlmGatewayService, useValue: llmGatewayMock },
      {
        provide: RateLimitService,
        useValue: { acquire: jest.fn().mockResolvedValue({ allowed: true, remaining: 999 }) },
      },
      { provide: APP_INTERCEPTOR, useClass: StubActorContextInterceptor },
    ],
  })
  class TestMemoryAnswerModule {}

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestMemoryAnswerModule],
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
    memoryRecallServiceMock.recall.mockResolvedValue(recallResult);
    llmGatewayMock.tryGenerateObject.mockResolvedValue({
      object: {
        answer: "Deploys happen on Tuesdays after QA sign-off.",
        citations: [
          {
            memory_id: MEMORY_ID,
            quote: "We deploy on Tuesdays after QA sign-off.",
          },
          {
            memory_id: "00000000-0000-0000-0000-00000000ffff",
            quote: "hallucinated",
          },
        ],
        confidence: 0.84,
      },
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the answer envelope and strips citations to recalled ids", async () => {
    const res = await request(app.getHttpServer())
      .post("/memories/answer")
      .send({
        project_id: PROJECT_ID,
        question: "When do we deploy?",
        limit: 5,
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    expect(res.body).toMatchObject({
      data: {
        answer: "Deploys happen on Tuesdays after QA sign-off.",
        citations: [
          {
            memory_id: MEMORY_ID,
            quote: "We deploy on Tuesdays after QA sign-off.",
          },
        ],
        confidence: 0.84,
        used_provider: "openai",
        recalled: recallResult.data,
        meta: {
          query_ms: 11,
          recall_count: 2,
        },
      },
      error: null,
      meta: null,
    });

    expect(memoryRecallServiceMock.recall).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        project_id: PROJECT_ID,
        query: "When do we deploy?",
        limit: 5,
      }),
    );
    expect(llmGatewayMock.tryGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("falls back to recalled evidence when no LLM provider is configured", async () => {
    llmGatewayMock.tryGenerateObject.mockResolvedValueOnce(null);

    const res = await request(app.getHttpServer())
      .post("/memories/answer")
      .send({
        project_id: PROJECT_ID,
        question: "What do we know about deploys?",
      })
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    expect(res.body).toMatchObject({
      data: {
        answer: null,
        citations: [],
        confidence: 0,
        used_provider: null,
        recalled: recallResult.data,
        meta: {
          query_ms: 11,
          recall_count: 2,
        },
      },
      error: null,
      meta: null,
    });
  });

  it("rejects invalid payloads with a 400 envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/memories/answer")
      .send({ question: "" })
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
