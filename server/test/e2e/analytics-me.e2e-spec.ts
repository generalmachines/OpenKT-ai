import { ExecutionContext, type INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { DRIZZLE } from "../../apps/server/src/db/drizzle.module";
import { AnalyticsController } from "../../apps/server/src/modules/analytics/controllers/analytics.controller";
import { AnalyticsQueryService } from "../../apps/server/src/modules/analytics/services/analytics-query.service";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";

// /v1/analytics/me — returns the caller's last-N-days rollup. We stub
// the Drizzle execute() with a known row set and verify the wire shape
// (snake-cased `{ data, error, meta }` envelope, items[] with the
// canonical column names).

const USER_ID = "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1";

const FAKE_ROW = {
  user_id: USER_ID,
  org_id: null as string | null,
  date: "2026-05-12",
  memories_created: 4,
  memories_recalled: 12,
  searches: 8,
  tokens_prompt: 1200,
  tokens_completion: 800,
  tokens_total: 2000,
  llm_calls: 3,
  llm_cost_usd: "0.000400",
  projects_active: 2,
  episodes_synthesized: 1,
  mcp_tool_calls: 7,
  sessions: 1,
  updated_at: "2026-05-12T22:00:00.000Z",
};

function fakeDb() {
  return {
    execute: jest.fn(async () => ({ rows: [{ ...FAKE_ROW }] })),
  };
}

function makeActorContext(): ActorContext {
  return {
    principal: {
      type: "user",
      userId: USER_ID,
      email: "tester@openkt.test",
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

describe("GET /v1/analytics/me (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const db = fakeDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: DRIZZLE, useValue: db },
        AnalyticsQueryService,
        { provide: APP_INTERCEPTOR, useClass: SnakeCaseResponseInterceptor },
      ],
    })
      .overrideGuard(SupabaseJwtGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<{
            actorContext?: ActorContext;
            header: (k: string) => string | undefined;
          }>();
          const auth = req.header?.("authorization");
          if (!auth || !auth.startsWith("Bearer ")) return false;
          req.actorContext = makeActorContext();
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

  it("returns { data, error, meta } envelope with daily rollup rows", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/analytics/me?days=7")
      .set("Authorization", "Bearer test")
      .expect(200);

    expect(res.body.error).toBeNull();
    expect(res.body.meta).toBeNull();
    expect(res.body.data).toBeDefined();
    expect(res.body.data.days).toBe(7);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    const row = res.body.data.items[0];
    expect(row).toMatchObject({
      user_id: USER_ID,
      date: "2026-05-12",
      memories_created: 4,
      memories_recalled: 12,
      tokens_total: 2000,
    });
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app.getHttpServer()).get("/v1/analytics/me");
    expect([401, 403]).toContain(res.status);
  });
});
