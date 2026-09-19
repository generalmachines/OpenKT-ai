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
import { PlatformAdminGuard } from "../../apps/server/src/modules/analytics/guards/platform-admin.guard";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { HealthDeepController } from "../../apps/server/src/modules/health-deep/controllers/health-deep.controller";
import { HealthDeepProbeService } from "../../apps/server/src/modules/health-deep/services/health-deep-probe.service";

// E2E coverage for /v1/internal/health-deep.
//
// We stub the Drizzle DB so SELECT 1 resolves, and stub global.fetch so
// every external probe (rabbitmq mgmt, memmachine /healthz, supabase
// /auth/v1/health, openai /v1/models, openrouter /api/v1/models) returns
// a 200. Guards are overridden so the test doesn't have to mint a real
// Supabase JWT.

const USER_ID = "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1";

function makeActorContext(): ActorContext {
  return {
    principal: {
      type: "user",
      userId: USER_ID,
      email: "admin-tester@openkt.test",
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

describe("GET /v1/internal/health-deep (e2e)", () => {
  let app: INestApplication;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/queues")) {
        return new Response(
          JSON.stringify([
            { name: "q.memory.embed", messages_ready: 2, consumers: 1 },
          ]),
          { status: 200 },
        );
      }
      // memmachine /healthz, supabase /auth/v1/health, openai /v1/models,
      // openrouter /api/v1/models → all happy path
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const db = { execute: jest.fn(async () => ({ rows: [{ "?column?": 1 }] })) };
    const config = {
      get: (key: string) => {
        const map: Record<string, string> = {
          OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
          OPENKT_RABBITMQ_MGMT_USER: "guest",
          OPENKT_RABBITMQ_MGMT_PASS: "guest",
          OPENKT_MEMMACHINE_URL: "http://memmachine:8080",
          SUPABASE_URL: "https://abc.supabase.co",
          OPENAI_API_KEY: "sk-test",
          OPENKT_DEFAULT_LLM_KEY: "sk-or-test",
        };
        return map[key];
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthDeepController],
      providers: [
        HealthDeepProbeService,
        { provide: DRIZZLE, useValue: db },
        { provide: "ConfigService", useValue: config },
        // Nest resolves ConfigService by class token — provide the class.
        {
          provide: require("@nestjs/config").ConfigService,
          useValue: config,
        },
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
      .overrideGuard(PlatformAdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1");
    app.use(json());
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await app.close();
  });

  it("returns overall=ok with per-service probe rows when every dep is reachable", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/internal/health-deep")
      .set("Authorization", "Bearer test")
      .expect(200);

    expect(res.body.error).toBeNull();
    expect(res.body.data.overall).toBe("ok");
    expect(typeof res.body.data.checked_at).toBe("string");
    const s = res.body.data.services;
    expect(s.rds.status).toBe("ok");
    expect(s.rabbitmq.status).toBe("ok");
    expect(s.rabbitmq.consumer_count).toBe(1);
    expect(s.memmachine.status).toBe("ok");
    expect(s.supabase.status).toBe("ok");
    expect(s.openai_embed.status).toBe("ok");
    expect(s.openrouter.status).toBe("ok");
  });

  it("rejects unauthenticated requests with 401/403", async () => {
    const res = await request(app.getHttpServer()).get("/v1/internal/health-deep");
    expect([401, 403]).toContain(res.status);
  });
});
