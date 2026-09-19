/**
 * Built-in accounts with Google sign-in NOT configured: the real AppModule,
 * booted with no OPENKT_GOOGLE_CLIENT_IDS and no SUPABASE_* variables. Its own
 * file because the app reads its environment once per module registry, and
 * jest gives every spec file a fresh one.
 */
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const UNSET = [
  "OPENKT_GOOGLE_CLIENT_IDS",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

describeIfDb("Built-in accounts (e2e) — Google not configured", () => {
  let app: INestApplication;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of UNSET) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    const { AppModule } = await import("../../apps/server/src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix("v1");
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it("providers says Google is off", async () => {
    const res = await request(app.getHttpServer()).get("/v1/auth/providers").expect(200);
    expect(res.body.data).toEqual({ password: true, google: { enabled: false } });
  });

  it("POST /v1/auth/google is 404 provider_disabled — before the token is even looked at", async () => {
    const res = await request(app.getHttpServer()).post("/v1/auth/google").send({ id_token: "anything" }).expect(404);
    expect(res.body.error.code).toBe("provider_disabled");
  });
});
