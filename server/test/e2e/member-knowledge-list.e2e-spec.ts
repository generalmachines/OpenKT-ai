import { ExecutionContext, type INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import { MemberKnowledgeController } from "../../apps/server/src/modules/member-knowledge/controllers/member-knowledge.controller";
import { MemberKnowledgeApplicationService } from "../../apps/server/src/modules/member-knowledge/services/member-knowledge-application.service";
import { LocalPgMemberKnowledgeRepository } from "../../apps/server/src/modules/member-knowledge/repositories/local-pg-member-knowledge.repository";

// Integration test for GET /v1/projects/:project_id/members. Stubs the
// repository (the DB layer is exercised by the local-pg smoke). What
// we're checking here is wire shape: route binding, zod parsing of the
// project_id route param, snake_case envelope, and the
// { data: [...], meta: {...} } shape inside the success wrapper.

// Use a valid UUID v4 — the project_id contract enforces v4 (the
// version nibble at position 14 must be `4`, and the variant nibble
// at position 19 must be `8|9|a|b`). The all-zero fixture used
// elsewhere predates that contract check.
const PROJECT_ID = "00000000-0000-4000-8000-0000000000cd";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

class GuardStub {
  canActivate(context: ExecutionContext): boolean {
    // Attach a synthetic ActorContext on the request so the
    // @ActorContextParam decorator picks it up. Mirrors what
    // SupabaseJwtGuard does in real life.
    const req = context.switchToHttp().getRequest();
    const actorContext: ActorContext = {
      principal: {
        kind: "user",
        userId: "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1",
        email: "test@openkt.test",
        roles: [],
      } as unknown as ActorContext["principal"],
      orgId: null,
      requestId: "test-request",
      surface: "api",
    } as unknown as ActorContext;
    req.actorContext = actorContext;
    return true;
  }
}

describe("GET /v1/projects/:project_id/members (e2e)", () => {
  let app: INestApplication;
  const listContributors = jest.fn();
  const repoStub = {
    listContributors,
    getMember: jest.fn(),
    mixMemories: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MemberKnowledgeController],
      providers: [
        MemberKnowledgeApplicationService,
        { provide: LocalPgMemberKnowledgeRepository, useValue: repoStub },
        { provide: APP_INTERCEPTOR, useClass: SnakeCaseResponseInterceptor },
      ],
    })
      .overrideGuard(SupabaseJwtGuard)
      .useClass(GuardStub)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1");
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    listContributors.mockReset();
  });

  it("returns the snake-cased members list inside the success envelope", async () => {
    listContributors.mockResolvedValueOnce([
      {
        user_id: USER_A,
        display_name: "Maya",
        avatar_url: null,
        memory_count: 7,
        episode_count: 0,
        themes: [{ tag: "auth", weight: 0.5, memory_count: 4 }],
        summary: "Drove the auth + invites push.",
        last_contribution_at: "2026-05-11T08:14:02.000Z",
      },
      {
        user_id: USER_B,
        display_name: null,
        avatar_url: null,
        memory_count: 2,
        episode_count: 0,
        themes: [],
        summary: null,
        last_contribution_at: "2026-05-10T08:14:02.000Z",
      },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/v1/projects/${PROJECT_ID}/members`)
      .expect(200);

    expect(response.body).toMatchObject({
      error: null,
      data: {
        data: [
          expect.objectContaining({
            user_id: USER_A,
            display_name: "Maya",
            memory_count: 7,
            themes: [
              expect.objectContaining({ tag: "auth", weight: 0.5 }),
            ],
            summary: "Drove the auth + invites push.",
          }),
          expect.objectContaining({
            user_id: USER_B,
            display_name: null,
            memory_count: 2,
            themes: [],
          }),
        ],
        meta: { project_id: PROJECT_ID, total: 2 },
      },
    });

    // Default page size flows through to the repo.
    expect(listContributors).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      50,
    );
  });

  it("honours the limit query parameter", async () => {
    listContributors.mockResolvedValueOnce([]);

    await request(app.getHttpServer())
      .get(`/v1/projects/${PROJECT_ID}/members?limit=3`)
      .expect(200);

    expect(listContributors).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, 3);
  });

  it("rejects a non-UUID project_id with a 400 error envelope", async () => {
    await request(app.getHttpServer())
      .get(`/v1/projects/not-a-uuid/members`)
      .expect(400);
    expect(listContributors).not.toHaveBeenCalled();
  });
});
