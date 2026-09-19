import {
  Controller,
  ExecutionContext,
  Get,
  type INestApplication,
  UseGuards,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { RateLimit } from "../../apps/server/src/modules/rate-limit/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../apps/server/src/modules/rate-limit/guards/rate-limit.guard";
import { RateLimitService } from "../../apps/server/src/modules/rate-limit/services/rate-limit.service";

// Smoke a single controller wired with @RateLimit and the
// RateLimitGuard. Inject a fake RateLimitService that toggles
// reject-after-N behaviour so we can assert the 429 envelope +
// Retry-After header.

const USER_ID = "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1";

@Controller("memories")
@UseGuards(SupabaseJwtGuard, RateLimitGuard)
class FakeMemoryController {
  @Get()
  @RateLimit({ key: "user", name: "memory_create", capacity: 2, refillPerSec: 1 })
  list() {
    return { data: { ok: true }, error: null, meta: null };
  }
}

class CountingRateLimitService {
  hits = 0;
  // capacity=2, fail third hit
  async acquire(_key: string, _capacity: number, _refill: number) {
    this.hits += 1;
    if (this.hits > 2) {
      return { allowed: false, remaining: 0, retryAfterMs: 1234 };
    }
    return { allowed: true, remaining: 2 - this.hits };
  }
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

describe("RateLimitGuard 429 envelope (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [FakeMemoryController],
      providers: [
        Reflector,
        { provide: RateLimitService, useValue: new CountingRateLimitService() },
        RateLimitGuard,
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

  it("returns 429 with Retry-After header + rate_limited error envelope after capacity hit", async () => {
    await request(app.getHttpServer())
      .get("/v1/memories")
      .set("Authorization", "Bearer test")
      .expect(200);
    await request(app.getHttpServer())
      .get("/v1/memories")
      .set("Authorization", "Bearer test")
      .expect(200);
    const blocked = await request(app.getHttpServer())
      .get("/v1/memories")
      .set("Authorization", "Bearer test")
      .expect(429);

    expect(blocked.headers["retry-after"]).toBe("2");
    expect(blocked.body.data).toBeNull();
    expect(blocked.body.error).toBeDefined();
    // AppExceptionFilter normalizes HttpException — the original
    // `{ code: "rate_limited", retry_after_ms }` body lands in
    // error.details and the top-level code becomes "http_exception".
    const details = blocked.body.error.details ?? {};
    expect(details.error?.code).toBe("rate_limited");
    expect(details.error?.retry_after_ms).toBe(1234);
  });
});
