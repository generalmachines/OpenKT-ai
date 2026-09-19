/**
 * E2E test for the briefings-v2 HTTP endpoints.
 *
 *   GET /v1/projects/:project_id/briefing
 *   GET /v1/projects/:project_id/changelog?since=<iso8601>
 *
 * The repository and ProjectScopeService are stubbed; the controller +
 * application services are wired through the real Nest pipeline with
 * the AppExceptionFilter and SnakeCaseResponseInterceptor in place so
 * we exercise the wire shape end-to-end.
 */

import { type INestApplication } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import request from "supertest";

import { LlmGatewayService } from "@openkt/platform-llm";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { DRIZZLE } from "../../apps/server/src/db/drizzle.module";
import { BriefingController } from "../../apps/server/src/modules/briefing/controllers/briefing.controller";
import { BriefingCacheRepository } from "../../apps/server/src/modules/briefing/repositories/briefing-cache.repository";
import { BriefingService } from "../../apps/server/src/modules/briefing/services/briefing.service";
import { ChangelogService } from "../../apps/server/src/modules/briefing/services/changelog.service";
import { ProjectScopeService } from "../../apps/server/src/modules/projects/services/project-scope.service";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";

const USER_ID = "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1";
// Use a valid UUID v4 — the project_id contract enforces v4 in the
// briefing/changelog route param schema (version nibble at index 14
// must be `4`, variant nibble at index 19 must be `8|9|a|b`).
const PROJECT_ID = "00000000-0000-4000-8000-000000000222";
const TEST_JWT = "test.jwt.value";

const NOW = new Date("2026-05-12T15:00:00.000Z");

// Guard stub — accepts any bearer token and injects a fixed actor
// context. The real Supabase resolution is exercised by profile-me.
class GuardStub {
  async canActivate(ctx: {
    switchToHttp: () => {
      getRequest: () => {
        actorContext?: unknown;
        header: (k: string) => string | undefined;
      };
    };
  }): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = req.header("authorization");
    if (!auth || !auth.startsWith("Bearer ")) return false;
    req.actorContext = {
      principal: { userId: USER_ID, kind: "user" },
      requestMetadata: { ip: "127.0.0.1", userAgent: "jest" },
    };
    return true;
  }
}

interface CacheRow {
  project_id: string;
  version: number;
  generated_at: string;
  stale_at: string | null;
  memory_count_at_generation: number;
  episode_count_at_generation: number;
  summary: string;
  themes: unknown[];
  key_decisions: unknown[];
  open_questions: unknown[];
  stats: Record<string, unknown>;
}

describe("/v1/projects/:project_id/briefing + /changelog (e2e)", () => {
  let app: INestApplication;
  let realDateNow: () => number;

  let cacheState: CacheRow | null;
  let outboxInserts: { aggregateType: string; eventType: string }[];

  // Accept the test project for every caller; out-of-scope tests for
  // membership-denied behaviour belong in the project-scope service's
  // own test, not here.
  const scopeStub = {
    requireProjectAccess: jest.fn(async (_ctx, projectId: string) => ({
      projectId,
      orgId: null,
      ownerUserId: USER_ID,
      role: "owner",
    })),
  };

  const repoStub: Partial<BriefingCacheRepository> = {
    async getByProjectId(projectId: string) {
      if (projectId !== cacheState?.project_id) return null;
      return cacheState;
    },
    async listNewMemoriesSince() {
      return [
        {
          // UUID v4: version nibble is `4`, variant nibble is `8|9|a|b`.
          id: "11111111-1111-4111-8111-111111111111",
          kind: "decision",
          content: "shipped topic-exchange RabbitMQ topology",
          tags: ["mq"],
          created_at: "2026-05-11T12:00:00.000Z",
          owner_user_id: USER_ID,
        },
      ];
    },
    async listArchivedMemoriesSince() {
      return [];
    },
    async listNewEpisodesSince() {
      return [
        {
          id: "22222222-2222-4222-8222-222222222222",
          summary: "RabbitMQ topology decision converged",
          created_at: "2026-05-11T12:00:00.000Z",
          updated_at: "2026-05-11T12:00:00.000Z",
          archived_at: null,
        },
      ];
    },
    async listSupersededEpisodesSince() {
      return [];
    },
    async findMostRecentActiveSibling() {
      return null;
    },
  };

  const drizzleStub = {
    insert: () => ({
      values: jest.fn(async (v: { aggregateType: string; eventType: string }) => {
        outboxInserts.push({ aggregateType: v.aggregateType, eventType: v.eventType });
      }),
    }),
  };

  const llmStub = {
    tryGenerateText: jest.fn().mockResolvedValue({
      text: "Between the timestamps the project converged on a topic-exchange RabbitMQ topology and captured one related decision.",
      provider: "minimax",
      model: "MiniMax-M2.5",
    }),
    tryGenerateObject: jest.fn(),
  };

  beforeAll(async () => {
    realDateNow = Date.now;
    Date.now = () => NOW.getTime();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BriefingController],
      providers: [
        BriefingService,
        ChangelogService,
        { provide: BriefingCacheRepository, useValue: repoStub },
        { provide: ProjectScopeService, useValue: scopeStub },
        { provide: LlmGatewayService, useValue: llmStub },
        { provide: DRIZZLE, useValue: drizzleStub },
        { provide: APP_INTERCEPTOR, useClass: SnakeCaseResponseInterceptor },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    })
      .overrideGuard(SupabaseJwtGuard)
      .useClass(GuardStub)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1");
    app.use(json());
    app.use(requestIdMiddleware);
    await app.init();
  });

  beforeEach(() => {
    cacheState = null;
    outboxInserts = [];
    scopeStub.requireProjectAccess.mockClear();
    llmStub.tryGenerateText.mockClear();
  });

  afterAll(async () => {
    Date.now = realDateNow;
    await app.close();
  });

  describe("GET /v1/projects/:project_id/briefing", () => {
    it("returns an empty placeholder + enqueues a refresh on cold start", async () => {
      cacheState = null;

      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/briefing`)
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        project_id: PROJECT_ID,
        version: 0,
        stale: true,
        summary: "",
        themes: [],
      });
      expect(outboxInserts).toHaveLength(1);
      expect(outboxInserts[0]).toMatchObject({
        aggregateType: "project",
        eventType: "project.briefing.refresh",
      });
    });

    it("returns the cached row when fresh (stale=false, no refresh enqueued)", async () => {
      cacheState = {
        project_id: PROJECT_ID,
        version: 5,
        generated_at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
        // 3h from now — not yet stale.
        stale_at: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        memory_count_at_generation: 12,
        episode_count_at_generation: 4,
        summary: "Project is consolidating around MQ topology.",
        themes: [
          {
            name: "MQ topology",
            description: "topic-exchange chosen over fanout",
            memory_ids: [],
            episode_ids: [],
          },
        ],
        key_decisions: [],
        open_questions: [],
        stats: { provider: "minimax" },
      };

      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/briefing`)
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        project_id: PROJECT_ID,
        version: 5,
        stale: false,
        summary: "Project is consolidating around MQ topology.",
      });
      expect(res.body.data.themes).toHaveLength(1);
      expect(outboxInserts).toHaveLength(0);
    });

    it("returns the cached row but flags stale + enqueues refresh when stale_at has passed", async () => {
      cacheState = {
        project_id: PROJECT_ID,
        version: 9,
        generated_at: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(),
        stale_at: new Date(NOW.getTime() - 60_000).toISOString(),
        memory_count_at_generation: 12,
        episode_count_at_generation: 4,
        summary: "stale-but-cached",
        themes: [],
        key_decisions: [],
        open_questions: [],
        stats: {},
      };

      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/briefing`)
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        project_id: PROJECT_ID,
        version: 9,
        stale: true,
        summary: "stale-but-cached",
      });
      expect(outboxInserts).toHaveLength(1);
      expect(outboxInserts[0].eventType).toBe("project.briefing.refresh");
    });

    it("rejects unauthenticated requests with 403", async () => {
      // GuardStub returns false for missing bearer; Nest renders 403.
      await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/briefing`)
        .expect(403);
    });

    it("rejects malformed project_id with 400", async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/not-a-uuid/briefing`)
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(400);
    });
  });

  describe("GET /v1/projects/:project_id/changelog", () => {
    it("returns memories + episodes + LLM summary for a valid since", async () => {
      const since = new Date(NOW.getTime() - 2 * 24 * 3_600_000).toISOString();

      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/changelog`)
        .query({ since })
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        since,
        summary: expect.stringContaining("topic-exchange"),
      });
      expect(res.body.data.new_memories).toHaveLength(1);
      expect(res.body.data.new_memories[0]).toMatchObject({
        kind: "decision",
        tags: ["mq"],
      });
      expect(res.body.data.new_episodes).toHaveLength(1);
      expect(res.body.data.archived_memories).toEqual([]);
      expect(res.body.data.superseded_episodes).toEqual([]);
    });

    it("rejects a missing `since` with 400", async () => {
      await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/changelog`)
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(400);
    });

    it("rejects a future `since` with 400", async () => {
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/changelog`)
        .query({ since: future })
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(400);
    });

    it("rejects a `since` more than 90 days back with 400", async () => {
      const tooOld = new Date(NOW.getTime() - 95 * 24 * 3_600_000).toISOString();
      await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/changelog`)
        .query({ since: tooOld })
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(400);
    });

    it("caches the LLM summary across calls within the same hour bucket", async () => {
      // Use a fresh `since` value so this test's hour-bucket cache key
      // doesn't collide with the one populated by the "returns memories
      // + episodes + LLM summary" sibling test above (ChangelogService
      // keeps an in-memory summary cache that survives between tests
      // since the Nest app is created in beforeAll).
      const since = new Date(NOW.getTime() - 5 * 24 * 3_600_000).toISOString();

      await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/changelog`)
        .query({ since })
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/changelog`)
        .query({ since })
        .set("Authorization", `Bearer ${TEST_JWT}`)
        .expect(200);

      // Two requests, one LLM call (cache hit on the second).
      expect(llmStub.tryGenerateText).toHaveBeenCalledTimes(1);
    });
  });
});
