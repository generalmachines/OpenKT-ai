/**
 * E2E test for GET /v1/memories/:memory_id/trace.
 *
 * Validates the full Nest request/response cycle for the trace path.
 * Routing → guard (overridden) → controller → MemoryTraceService →
 * Drizzle (mocked at the DRIZZLE provider level) → response shaper.
 *
 * The trace endpoint executes four parallel reads (memory row,
 * tags, agentic_jobs, episode + members, similarity neighbours). We
 * mock the DrizzleDb so we can hand-roll each statement's response
 * in order and verify the stages array, resulting_episode, and
 * related_memories sections all populate.
 *
 * What is real:
 *   - MemoryTraceController, MemoryTraceService, the parameter
 *     decorator + zod validation pipe, the pagedResponse / okResponse
 *     envelope, the request-id middleware, the AppExceptionFilter.
 *
 * What is mocked:
 *   - SupabaseJwtGuard (overridden, injects a synthetic ActorContext)
 *   - DRIZZLE provider (each .execute() returns the next queued row set)
 *   - @openkt/auth-authorization.requireMemoryReadAccess (so we don't
 *     need a real local pg pool to resolve membership)
 */
jest.mock("@openkt/auth-authorization", () => {
  const actual = jest.requireActual("@openkt/auth-authorization");
  return {
    ...actual,
    requireMemoryReadAccess: jest.fn().mockResolvedValue({
      memoryId: "00000000-0000-4000-8000-0000000000ab",
      orgId: null,
      projectId: "00000000-0000-0000-0000-000000000001",
      ownerUserId: "00000000-0000-0000-0000-0000000000aa",
      visibility: "project",
      via: "owner",
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
import { MemoryTraceController } from "../../apps/server/src/modules/memory/controllers/memory-trace.controller";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { MemoryTraceService } from "../../apps/server/src/modules/memory/services/memory-trace.service";
import { DRIZZLE } from "../../apps/server/src/db/drizzle.module";

// Valid UUID v4 — version nibble (index 14) is `4`, variant nibble
// (index 19) is `8|9|a|b`. The route param zod schema enforces v4.
const MEMORY_ID = "00000000-0000-4000-8000-0000000000ab";
const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const EPISODE_ID = "00000000-0000-0000-0000-0000000000c1";
const RELATED_ID = "00000000-0000-0000-0000-0000000000c2";

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

// Drizzle `.execute()` is called by MemoryTraceService in this order:
//   1) load memory row
//   2) load tag slugs
//   3) load agentic_jobs
//   4) load resulting episode row
//   5) load related memories
//   6) load llm_calls grouped by stage (migration 0025)
//   7) load semantic neighbors (memory_neighbors, migration 0026)
//   (8) load shared-episode member ids (only if related has hits;
//       awaited inside loadRelatedMemories after its own execute)
//
// We queue them in that order. The five loaders fan out via Promise.all
// but each one fires its db.execute synchronously before awaiting, so
// the cursor advances in source-order. The shared-episode call lands
// last because it only fires after the related-memories cursor resolves.
function buildDrizzleMock(rowSets: unknown[][]) {
  let cursor = 0;
  return {
    execute: jest.fn().mockImplementation(async () => {
      const rows = rowSets[cursor] ?? [];
      cursor += 1;
      return { rows };
    }),
  };
}

describe("MemoryTraceController GET /memories/:memory_id/trace (e2e)", () => {
  let app: INestApplication;
  const stubBypassGuard = { canActivate: () => true };

  const memoryRows = [
    {
      id: MEMORY_ID,
      kind: "decision",
      content: "we chose Postgres + pgvector for embeddings",
      confidence: 0.91,
      created_at: "2026-05-01T10:00:00.000Z",
      owner_user_id: USER_ID,
      project_id: PROJECT_ID,
    },
  ];

  const tagRows = [{ slug: "infra" }, { slug: "postgres" }];

  const jobRows = [
    {
      id: "j1",
      kind: "preprocess",
      stage: "preprocess",
      status: "done",
      started_at: "2026-05-01T10:00:01.000Z",
      completed_at: "2026-05-01T10:00:01.412Z",
      created_at: "2026-05-01T10:00:00.500Z",
      result: { extracted_kind: "decision" },
      error: null,
    },
    {
      id: "j2",
      kind: "embed",
      stage: "embed",
      status: "done",
      started_at: "2026-05-01T10:00:01.500Z",
      completed_at: "2026-05-01T10:00:02.000Z",
      created_at: "2026-05-01T10:00:01.500Z",
      result: { dimension: 1024 },
      error: null,
    },
    {
      id: "j3",
      kind: "triage",
      stage: "triage",
      status: "failed",
      started_at: "2026-05-01T10:00:02.500Z",
      completed_at: "2026-05-01T10:00:02.700Z",
      created_at: "2026-05-01T10:00:02.500Z",
      result: null,
      error: "llm timeout",
    },
  ];

  const episodeRow = [
    {
      id: EPISODE_ID,
      summary: "Postgres pgvector adoption thread",
      created_at: "2026-05-01T10:00:03.500Z",
      added_at: "2026-05-01T10:00:03.500Z",
      similarity_at_join: 0.92,
    },
  ];

  const relatedRows = [
    { id: RELATED_ID, preview: "memmachine layered over pgvector", similarity: 0.94 },
  ];

  // Pre-computed neighbor rows from the new memory_neighbors table.
  // Empty by default — the e2e test doesn't assert on the field, but
  // the cursor must advance past this slot so sharedEpisodeRows lands
  // in slot 7 (see comment above buildDrizzleMock).
  const neighborRows: Array<{
    id: string;
    preview: string;
    similarity: number;
    computed_at: string;
  }> = [];

  const sharedEpisodeRows = [{ memory_id: RELATED_ID }];

  // After Promise.all resolves, the trace service queries for
  // project-scoped jobs (briefing, member_knowledge_synthesis) that
  // fired during the memory's processing window. Empty here so the
  // existing e2e contract stays the same — project-scoped stages get
  // their own dedicated test in the unit suite.
  const projectScopedJobRows: unknown[] = [];

  // llm_calls rows are loaded after related so the trace can attach
  // them under stage.llm_calls. Two rows here: a successful triage
  // call (with prompt + response captured per migration 0025) and a
  // synthesize call.
  const llmCallRows = [
    {
      id: "lc-1",
      provider: "minimax",
      model: "MiniMax-M2.7",
      stage: "triage",
      prompt_messages: [
        { role: "system", content: "You analyse a NEW project memory..." },
        { role: "user", content: "<untrusted-content>NEW memory:..." },
      ],
      response_text: '{"tags":["postgres"],"duplicate_of":null,"supersedes":null}',
      response_metadata: { id: "chat-abc", finish_reason: "stop" },
      prompt_tokens: 220,
      completion_tokens: 40,
      latency_ms: 412,
      status: "success",
      error_reason: null,
      truncated: false,
      created_at: "2026-05-01T10:00:02.600Z",
    },
  ];

  beforeAll(async () => {
    const drizzleMock = buildDrizzleMock([
      memoryRows,
      tagRows,
      jobRows,
      episodeRow,
      relatedRows,
      llmCallRows,
      neighborRows,
      sharedEpisodeRows,
      projectScopedJobRows,
    ]);

    @Module({
      controllers: [MemoryTraceController],
      providers: [
        MemoryTraceService,
        { provide: DRIZZLE, useValue: drizzleMock },
        { provide: APP_INTERCEPTOR, useClass: StubActorContextInterceptor },
      ],
    })
    class TestTraceModule {}

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestTraceModule],
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

  it("returns the trace envelope with stages, episode, and related memories", async () => {
    const res = await request(app.getHttpServer())
      .get(`/memories/${MEMORY_ID}/trace`)
      .set("Authorization", "Bearer ignored-by-stub-guard")
      .expect(200);

    expect(res.body).toMatchObject({
      data: {
        memory: expect.objectContaining({
          id: MEMORY_ID,
          kind: "decision",
          project_id: PROJECT_ID,
          tags: ["infra", "postgres"],
          content_preview: expect.stringContaining("Postgres"),
        }),
        stages: expect.arrayContaining([
          expect.objectContaining({
            stage: "preprocess",
            status: "completed",
            output: { extracted_kind: "decision" },
            duration_ms: 412,
          }),
          expect.objectContaining({
            stage: "embed",
            status: "completed",
            duration_ms: 500,
          }),
          expect.objectContaining({
            stage: "triage",
            status: "failed",
            error_reason: "llm timeout",
            llm_calls: expect.arrayContaining([
              expect.objectContaining({
                id: "lc-1",
                provider: "minimax",
                model: "MiniMax-M2.7",
                status: "success",
                response_text: expect.stringContaining("postgres"),
                prompt_messages: expect.any(Array),
                truncated: false,
              }),
            ]),
          }),
        ]),
        resulting_episode: expect.objectContaining({
          id: EPISODE_ID,
          summary: "Postgres pgvector adoption thread",
          synthesis_action: "create",
        }),
        related_memories: [
          expect.objectContaining({
            id: RELATED_ID,
            similarity: 0.94,
            relation: "in_same_episode",
          }),
        ],
        timing: expect.objectContaining({
          total_ms: expect.any(Number),
        }),
      },
      error: null,
    });
  });

  it("rejects a non-uuid memory_id with a 400 envelope", async () => {
    const res = await request(app.getHttpServer())
      .get("/memories/not-a-uuid/trace")
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
