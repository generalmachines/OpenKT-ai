import { ExecutionContext, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { DRIZZLE } from "../../apps/server/src/db/drizzle.module";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { LlmCallsController } from "../../apps/server/src/modules/observability/controllers/llm-calls.controller";
import { UserQuotaController } from "../../apps/server/src/modules/observability/controllers/user-quota.controller";
import { LlmCallQueryService } from "../../apps/server/src/modules/observability/services/llm-call-query.service";
import { PipelineHealthService } from "../../apps/server/src/modules/observability/services/pipeline-health.service";
import { UserQuotaService } from "../../apps/server/src/modules/observability/services/user-quota.service";

// Integration coverage for the new observability surface:
//   - "inserts" a fake llm_calls row via a stubbed Drizzle DB,
//   - hits GET /v1/observability/llm-calls,
//   - asserts the wire shape matches the LlmCallRow contract.
//
// The SupabaseJwtGuard is overridden with a stub that injects a known
// ActorContext onto the request. The real guard's behaviour is covered
// by profile-me.e2e-spec.ts.

const USER_ID = "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1";

const FAKE_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  project_id: null as string | null,
  user_id: USER_ID,
  provider: "minimax",
  model: "MiniMax-M2.5",
  stage: "triage",
  purpose: "extract-tags",
  memory_id: null as string | null,
  episode_id: null as string | null,
  prompt_tokens: 120,
  completion_tokens: 80,
  total_tokens: 200,
  cost_usd: "0.000132",
  latency_ms: 540,
  status: "success",
  error_reason: null as string | null,
  request_id: "req-1",
  created_at: "2026-05-12T10:00:00.000Z",
};

function fakeDb() {
  return {
    execute: jest.fn(async (statement: unknown) => {
      const stmt = stringify(statement);
      if (stmt.includes("from llm_calls")) {
        return { rows: [{ ...FAKE_ROW }] };
      }
      return { rows: [] };
    }),
  };
}

function stringify(statement: unknown): string {
  if (!statement || typeof statement !== "object") return String(statement);
  const sqlString = (statement as { sql?: unknown }).sql;
  if (typeof sqlString === "string") return sqlString;
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    return chunks
      .map((chunk) =>
        chunk && typeof chunk === "object" && "value" in (chunk as object)
          ? String((chunk as { value: unknown }).value ?? "")
          : String(chunk ?? ""),
      )
      .join(" ");
  }
  return JSON.stringify(statement);
}

function makeActorContext(): ActorContext {
  return {
    principal: {
      type: "user",
      userId: USER_ID,
      email: "obs-tester@openkt.test",
      displayName: null,
      authSource: "supabase-jwt",
    },
    request: {
      requestId: "test-req",
      ip: null,
      userAgent: null,
      surface: "api",
      actorKind: "user",
    } as never,
    sb: {} as never,
    admin: () => ({}) as never,
  };
}

describe("GET /v1/observability/llm-calls (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const db = fakeDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [LlmCallsController, UserQuotaController],
      providers: [
        { provide: DRIZZLE, useValue: db },
        LlmCallQueryService,
        PipelineHealthService,
        UserQuotaService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: APP_INTERCEPTOR, useClass: SnakeCaseResponseInterceptor },
      ],
    })
      .overrideGuard(SupabaseJwtGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const request = context.switchToHttp().getRequest<{
            actorContext?: ActorContext;
            header: (k: string) => string | undefined;
          }>();
          const auth = request.header?.("authorization");
          if (!auth || !auth.startsWith("Bearer ")) {
            return false;
          }
          request.actorContext = makeActorContext();
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1");
    app.use(json());
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the canonical { data, error, meta } envelope with items[] of llm_calls", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/observability/llm-calls")
      .set("Authorization", "Bearer test")
      .expect(200);

    expect(res.body.error).toBeNull();
    expect(res.body.meta).toBeNull();
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    const row = res.body.data.items[0];
    expect(row).toMatchObject({
      id: FAKE_ROW.id,
      provider: "minimax",
      model: "MiniMax-M2.5",
      stage: "triage",
      purpose: "extract-tags",
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
      status: "success",
      latency_ms: 540,
    });
    expect(res.body.data).toHaveProperty("next_cursor");
  });

  it("rejects unauthenticated requests with 403/401", async () => {
    const res = await request(app.getHttpServer()).get("/v1/observability/llm-calls");
    expect([401, 403]).toContain(res.status);
  });

  it("forbids reading another user's quota", async () => {
    const otherUserId = "00000000-0000-4000-8000-000000000099";
    await request(app.getHttpServer())
      .get(`/v1/users/${otherUserId}/quota`)
      .set("Authorization", "Bearer test")
      .expect(403);
  });
});
