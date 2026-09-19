/**
 * E2E test for CORS configuration applied in apps/server/src/main.ts.
 *
 * Why this test exists: the dashboard now hits the BFF /v1/auth/* endpoints
 * with `credentials: "include"`. Without CORS the browser preflight
 * (OPTIONS /v1/auth/password) returns 404 and the actual POST never fires.
 * That broke browser sign-in immediately after the auth refactor merged
 * (commit 345359c, ok-9u5c).
 *
 * The CORS config is exposed as a small library (@openkt/platform-cors)
 * so it can be applied to a Nest test app without booting the entire
 * AppModule (which would require Postgres, RabbitMQ, Supabase). The same
 * library is what main.ts calls before app.listen.
 */
import {
  Controller,
  type INestApplication,
  Module,
  Post,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { enableCorsFromEnv } from "@openkt/platform-cors";

@Controller("auth")
class StubAuthController {
  @Post("password")
  passwordLogin(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [StubAuthController] })
class StubAuthModule {}

async function bootCorsApp(corsAllowedOrigins?: string): Promise<INestApplication> {
  if (corsAllowedOrigins === undefined) {
    delete process.env.CORS_ALLOWED_ORIGINS;
  } else {
    process.env.CORS_ALLOWED_ORIGINS = corsAllowedOrigins;
  }

  const moduleRef = await Test.createTestingModule({
    imports: [StubAuthModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  enableCorsFromEnv(app);
  await app.init();
  return app;
}

describe("CORS (e2e)", () => {
  let app: INestApplication;
  const originalEnv = process.env.CORS_ALLOWED_ORIGINS;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (originalEnv === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = originalEnv;
    }
  });

  it("OPTIONS /v1/auth/password from an allowlisted origin returns 204 with the expected CORS headers", async () => {
    app = await bootCorsApp(
      "http://localhost:5273,http://100.74.238.87:5273",
    );

    const res = await request(app.getHttpServer())
      .options("/v1/auth/password")
      .set("Origin", "http://localhost:5273")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Authorization,Content-Type")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5273",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");

    const allowMethods = String(
      res.headers["access-control-allow-methods"] ?? "",
    ).toUpperCase();
    expect(allowMethods).toContain("POST");

    const allowHeaders = String(
      res.headers["access-control-allow-headers"] ?? "",
    ).toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("content-type");
  });

  it("echoes the second allowlisted origin verbatim (proves CSV parsing, not a single hard-coded value)", async () => {
    app = await bootCorsApp(
      "http://localhost:5273,http://100.74.238.87:5273",
    );

    const res = await request(app.getHttpServer())
      .options("/v1/auth/password")
      .set("Origin", "http://100.74.238.87:5273")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://100.74.238.87:5273",
    );
  });

  it("does not return Access-Control-Allow-Origin for an origin outside the allowlist", async () => {
    app = await bootCorsApp("http://localhost:5273");

    const res = await request(app.getHttpServer())
      .options("/v1/auth/password")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("falls back to the dev defaults (localhost:5273 + tailnet host) when CORS_ALLOWED_ORIGINS is unset", async () => {
    app = await bootCorsApp(undefined);

    const res = await request(app.getHttpServer())
      .options("/v1/auth/password")
      .set("Origin", "http://localhost:5273")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5273",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("sends Access-Control-Allow-Credentials on the actual POST so the browser keeps the response", async () => {
    app = await bootCorsApp("http://localhost:5273");

    const res = await request(app.getHttpServer())
      .post("/v1/auth/password")
      .set("Origin", "http://localhost:5273")
      .send({})
      .expect(201);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5273",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
