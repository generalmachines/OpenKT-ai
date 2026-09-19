/**
 * Integration coverage for GET /v1/audit/orgs/:org_id.
 *
 * Builds a NestJS test app with:
 *   - the real AuditController + AuditQueryService
 *   - a fake DRIZZLE handle that returns rows for `from audit_log`
 *     queries and an org-membership row for the guard's org-resolution
 *   - a stub SupabaseJwtGuard that injects a known ActorContext when an
 *     Authorization header is present
 *
 * Asserts:
 *   - 403 when the caller is a `member` of the org (admin role required)
 *   - 200 + paginated wire shape when the caller is `admin`
 *   - 401/403 for missing auth header
 */
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
import { AuditController } from "../../apps/server/src/modules/audit/controllers/audit.controller";
import { AuditQueryService } from "../../apps/server/src/modules/audit/services/audit-query.service";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { RequireOrgRoleGuard } from "../../apps/server/src/modules/invites/guards/require-org-role.guard";

const ADMIN_USER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

const FAKE_AUDIT_ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  actor_id: ADMIN_USER_ID,
  actor_kind: "user",
  org_id: ORG_ID,
  action: "org.invite.created",
  resource_type: "org_invite",
  resource_id: "55555555-5555-4555-8555-555555555555",
  before: null as unknown,
  after: { role: "member" },
  ip_inet: "203.0.113.10",
  user_agent: "jest",
  request_id: "req-1",
  occurred_at: "2026-05-12T10:00:00.000Z",
};

let currentUserId = ADMIN_USER_ID;

function fakeDb() {
  return {
    // The RequireOrgRoleGuard goes through `db.query.orgMembers.findFirst`
    // and `db.query.orgs.findFirst`; the guard's resolution code only
    // queries `orgMembers` when an orgId is already known via `params.orgId`,
    // which the controller passes through.
    query: {
      orgMembers: {
        findFirst: jest.fn(async () => ({
          orgId: ORG_ID,
          userId: currentUserId,
          role: currentUserId === ADMIN_USER_ID ? "admin" : "member",
          invitedBy: null,
        })),
      },
      orgs: { findFirst: jest.fn(async () => null) },
      orgInvites: { findFirst: jest.fn(async () => null) },
    },
    execute: jest.fn(async (statement: unknown) => {
      const stmt = stringify(statement);
      if (stmt.includes("from audit_log")) {
        return { rows: [{ ...FAKE_AUDIT_ROW }] };
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

function makeActorContext(userId: string): ActorContext {
  return {
    principal: {
      type: "user",
      userId,
      email: `${userId}@openkt.test`,
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

describe("GET /v1/audit/orgs/:org_id (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const db = fakeDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: DRIZZLE, useValue: db },
        AuditQueryService,
        RequireOrgRoleGuard,
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
          request.actorContext = makeActorContext(currentUserId);
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

  beforeEach(() => {
    currentUserId = ADMIN_USER_ID;
  });

  it("returns the canonical envelope with items[] for an org admin", async () => {
    currentUserId = ADMIN_USER_ID;
    const res = await request(app.getHttpServer())
      .get(`/v1/audit/orgs/${ORG_ID}`)
      .set("Authorization", "Bearer test")
      .expect(200);

    expect(res.body.error).toBeNull();
    expect(res.body.meta).toBeNull();
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      id: FAKE_AUDIT_ROW.id,
      action: "org.invite.created",
      actor_id: ADMIN_USER_ID,
      org_id: ORG_ID,
      resource_type: "org_invite",
    });
    expect(res.body.data).toHaveProperty("next_cursor");
  });

  it("rejects requests from a non-admin member with 403", async () => {
    currentUserId = MEMBER_USER_ID;
    const res = await request(app.getHttpServer())
      .get(`/v1/audit/orgs/${ORG_ID}`)
      .set("Authorization", "Bearer test");
    expect(res.status).toBe(403);
  });

  it("rejects requests without an auth header", async () => {
    const res = await request(app.getHttpServer()).get(`/v1/audit/orgs/${ORG_ID}`);
    expect([401, 403]).toContain(res.status);
  });

  it("validates limit upper bound (max 100)", async () => {
    currentUserId = ADMIN_USER_ID;
    const res = await request(app.getHttpServer())
      .get(`/v1/audit/orgs/${ORG_ID}`)
      .query({ limit: "500" })
      .set("Authorization", "Bearer test");
    // Validation failures surface as 422 via the global filter.
    expect([400, 422]).toContain(res.status);
  });
});
