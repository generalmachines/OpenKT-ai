import {
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { json } from "express";
import request from "supertest";

import {
  SupabaseAdminClientFactory,
  SupabaseUserClientFactory,
} from "@openkt/data-supabase";
import type { ActorContext } from "@openkt/core-context";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import { AppExceptionFilter } from "../../apps/server/src/common/filters/app-exception.filter";
import { SnakeCaseResponseInterceptor } from "../../apps/server/src/common/interceptors/snake-case-response.interceptor";
import { requestIdMiddleware } from "../../apps/server/src/common/middleware/request-id.middleware";
import { ActorContextFactory } from "../../apps/server/src/modules/auth/services/actor-context.factory";
import { PrincipalResolutionService } from "../../apps/server/src/modules/auth/services/principal-resolution.service";
import {
  type SupabaseJwtClaims,
  SupabaseJwtVerifier,
} from "../../apps/server/src/modules/auth/services/supabase-jwt-verifier.service";
import { SupabaseJwtGuard } from "../../apps/server/src/modules/auth/guards/supabase-jwt.guard";
import {
  ProfileController,
  ProfileMeController,
} from "../../apps/server/src/modules/profile/controllers/profile.controller";
import { ProfileApplicationService } from "../../apps/server/src/modules/profile/services/profile-application.service";
import {
  PROFILE_REPOSITORY,
  type ProfileRecord,
  type ProfileRepository,
  type UpdateProfileRecord,
} from "@openkt/data-repositories";
import { DRIZZLE } from "../../apps/server/src/db/drizzle.module";

// Full request-stack test for /v1/me and /v1/profile/me: JWT guard ->
// principal resolution -> profile repository -> snake-case interceptor.
//
// The point of testing through the guard (rather than stubbing
// ActorContext directly) is exactly to catch regressions like
// "/v1/me returns user_id: null" — the symptom only shows up when
// the principal-resolution path is exercised end-to-end.
//
// Coverage:
//   - Legacy /v1/me success path (back-compat with shipping CLI builds).
//   - JWT failure / bad token / id-less user → 401.
//   - /v1/profile/me cold-start with GitHub user_metadata → lazy-create.
//   - /v1/profile/me upgrade path: existing email-only profile, new JWT
//     reports auth_provider='github' → GitHub fields backfilled.
//   - PATCH /v1/profile/me updates display_name / bio only — never
//     email / github_username / auth_provider.

const USER_ID = "f36a1bbe-b6d3-43f1-bbab-64c000ee79b1";
const USER_EMAIL = "alex+dev@openkt.test";
const TEST_JWT = "test.jwt.value";

type StoredProfile = ProfileRecord;

function emptyProfileStore(): Map<string, StoredProfile> {
  return new Map();
}

function makeEmailProfile(): StoredProfile {
  return {
    userId: USER_ID,
    email: USER_EMAIL,
    displayName: null,
    avatarUrl: null,
    githubUsername: null,
    githubId: null,
    authProvider: "email",
    bio: null,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
  };
}

// In-memory repository that mirrors the real Drizzle lazy-create /
// upgrade contract. Tests assert on the visible behaviour (response
// shape, mutation effects) rather than poking at the DB.
function makeRepo(store: Map<string, StoredProfile>): ProfileRepository {
  return {
    async getMe(context: ActorContext): Promise<ProfileRecord | null> {
      const principal = context.principal;
      const userId = principal.userId;
      if (!userId) return null;
      const existing = store.get(userId);
      const oauth = principal.oauthIdentity ?? null;
      if (!existing) {
        const created: StoredProfile = {
          userId,
          email: principal.email,
          displayName:
            oauth?.fullName ?? principal.displayName ?? principal.email ?? null,
          avatarUrl: oauth?.avatarUrl ?? null,
          githubUsername: oauth?.githubUsername ?? null,
          githubId: oauth?.githubId ?? null,
          authProvider: oauth?.provider ?? "email",
          bio: null,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        };
        store.set(userId, created);
        return created;
      }
      if (
        oauth &&
        oauth.provider === "github" &&
        existing.authProvider === "email"
      ) {
        const upgraded: StoredProfile = {
          ...existing,
          githubUsername: oauth.githubUsername ?? null,
          githubId: oauth.githubId ?? null,
          avatarUrl: oauth.avatarUrl ?? null,
          authProvider: "github",
          updatedAt: "2026-05-13T00:00:00.000Z",
        };
        store.set(userId, upgraded);
        return upgraded;
      }
      return existing;
    },
    async updateMe(
      context: ActorContext,
      input: UpdateProfileRecord,
    ): Promise<ProfileRecord> {
      const userId = context.principal.userId!;
      const current = (await this.getMe(context)) as StoredProfile;
      const patched: StoredProfile = {
        ...current,
        displayName:
          input.displayName !== undefined ? input.displayName : current.displayName,
        avatarUrl:
          input.avatarUrl !== undefined ? input.avatarUrl : current.avatarUrl,
        bio: input.bio !== undefined ? input.bio : current.bio,
        updatedAt: "2026-05-13T00:00:01.000Z",
      };
      store.set(userId, patched);
      return patched;
    },
  };
}

// Fake admin client. Two surfaces matter: auth.getUser(jwt) for the
// principal-resolution path, and from("profiles") for the display-name
// lookup that runs alongside.
function fakeAdminClient(opts: {
  user:
    | {
        id: string;
        email: string | null;
        user_metadata?: Record<string, unknown>;
        app_metadata?: Record<string, unknown>;
      }
    | null;
  authError?: { message: string } | null;
}) {
  return {
    provider: "supabase" as const,
    kind: "admin" as const,
    auth: {
      async getUser(_jwt: string) {
        if (opts.authError || !opts.user) {
          return {
            data: { user: null },
            error: opts.authError ?? { message: "no user" },
          };
        }
        return { data: { user: opts.user }, error: null };
      },
    },
  };
}

// Fake user-scoped client. The new repository implementation does not
// reach into Supabase for /v1/profile/me — everything is done against
// Drizzle. The factory is still wired so ActorContextFactory can build
// the context.
function fakeUserClient() {
  return {
    provider: "supabase" as const,
    kind: "user-scoped" as const,
  };
}

describe("/v1/me + /v1/profile/me (e2e)", () => {
  let app: INestApplication;
  // Single Map reference shared between the repository factory and every
  // test. `beforeEach` mutates this Map in-place (clear + set) so the
  // captured reference stays valid across tests.
  const store: Map<string, StoredProfile> = emptyProfileStore();
  let currentAuthUser:
    | {
        id: string;
        email: string | null;
        user_metadata?: Record<string, unknown>;
        app_metadata?: Record<string, unknown>;
      }
    | null;
  let currentAuthError: { message: string } | null;

  const adminFactoryStub = {
    getClient() {
      return fakeAdminClient({
        user: currentAuthUser,
        authError: currentAuthError,
      }) as unknown as ReturnType<SupabaseAdminClientFactory["getClient"]>;
    },
  };

  const userFactoryStub = {
    bind(_jwt: string) {
      return fakeUserClient() as unknown as ReturnType<
        SupabaseUserClientFactory["bind"]
      >;
    },
  };

  // PrincipalResolutionService now delegates JWT verification to a
  // SupabaseJwtVerifier service. We stub it directly — the test doesn't
  // mint real JWTs, it just hands the controller a fake bearer string
  // and expects the controller's guard to accept it.
  const jwtVerifierStub: Pick<SupabaseJwtVerifier, "verify"> = {
    async verify(_jwt: string): Promise<SupabaseJwtClaims> {
      if (currentAuthError || !currentAuthUser) {
        // Real verifier throws UnauthorizedDomainError on invalid /
        // expired / unknown-kid tokens. Mirror that so the
        // exception filter converts it to 401, not 500.
        throw new UnauthorizedDomainError("invalid or expired bearer token");
      }
      return {
        sub: currentAuthUser.id,
        email: currentAuthUser.email ?? undefined,
        aud: "authenticated",
        user_metadata: currentAuthUser.user_metadata,
        app_metadata: currentAuthUser.app_metadata,
      };
    },
  };

  // PrincipalResolutionService also reaches into Drizzle to look up
  // display_name — short-circuit that with an in-memory shim that reads
  // the same store.
  const drizzleStub = {
    select(_columns: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(_predicate: unknown) {
              return {
                async limit(_n: number) {
                  const row = store.get(USER_ID);
                  return row ? [{ displayName: row.displayName }] : [];
                },
              };
            },
          };
        },
      };
    },
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProfileController, ProfileMeController],
      providers: [
        ProfileApplicationService,
        {
          provide: PROFILE_REPOSITORY,
          useFactory: () => makeRepo(store),
        },
        ActorContextFactory,
        PrincipalResolutionService,
        SupabaseJwtGuard,
        { provide: SupabaseJwtVerifier, useValue: jwtVerifierStub },
        { provide: SupabaseAdminClientFactory, useValue: adminFactoryStub },
        { provide: SupabaseUserClientFactory, useValue: userFactoryStub },
        { provide: DRIZZLE, useValue: drizzleStub },
        { provide: APP_INTERCEPTOR, useClass: SnakeCaseResponseInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1");
    app.use(json());
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  beforeEach(() => {
    // Wipe-in-place so the repository factory's captured reference stays
    // valid. Replacing the Map would orphan the closure.
    store.clear();
    currentAuthUser = {
      id: USER_ID,
      email: USER_EMAIL,
      user_metadata: {},
      app_metadata: { provider: "email" },
    };
    currentAuthError = null;
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns data.user_id matching the JWT-resolved user UUID (/v1/me)", async () => {
    store.set(USER_ID, makeEmailProfile());

    const res = await request(app.getHttpServer())
      .get("/v1/me")
      .set("Authorization", `Bearer ${TEST_JWT}`)
      .expect(200);

    expect(res.body.data.user_id).toBe(USER_ID);
    expect(res.body.data.email).toBe(USER_EMAIL);
    // The original symptom: data.user_id was null. Pin it down explicitly.
    expect(res.body.data.user_id).not.toBeNull();
  });

  it("rejects requests without a bearer token", async () => {
    await request(app.getHttpServer()).get("/v1/me").expect(401);
    await request(app.getHttpServer()).get("/v1/profile/me").expect(401);
  });

  it("rejects requests when Supabase fails to resolve the JWT", async () => {
    currentAuthUser = null;
    currentAuthError = { message: "invalid token" };
    await request(app.getHttpServer())
      .get("/v1/profile/me")
      .set("Authorization", `Bearer ${TEST_JWT}`)
      .expect(401);
  });

  it("rejects requests when Supabase returns a user with no id", async () => {
    // The original symptom: response had a populated email but
    // user_id: null. That can only reach the wire if the principal-
    // resolution path treats an `id`-less Supabase user as valid.
    currentAuthUser = { id: "", email: USER_EMAIL };
    await request(app.getHttpServer())
      .get("/v1/profile/me")
      .set("Authorization", `Bearer ${TEST_JWT}`)
      .expect(401);
  });

  it("cold-start /v1/profile/me with GitHub user_metadata lazy-creates the row", async () => {
    currentAuthUser = {
      id: USER_ID,
      email: USER_EMAIL,
      user_metadata: {
        user_name: "alexdev",
        provider_id: "1234567",
        avatar_url: "https://avatars.githubusercontent.com/u/1234567",
        full_name: "Alex Dev",
      },
      app_metadata: { provider: "github" },
    };

    const res = await request(app.getHttpServer())
      .get("/v1/profile/me")
      .set("Authorization", `Bearer ${TEST_JWT}`)
      .expect(200);

    expect(res.body.data).toMatchObject({
      user_id: USER_ID,
      email: USER_EMAIL,
      display_name: "Alex Dev",
      avatar_url: "https://avatars.githubusercontent.com/u/1234567",
      github_username: "alexdev",
      github_id: "1234567",
      auth_provider: "github",
      bio: null,
    });
    expect(store.get(USER_ID)).toBeDefined();
  });

  it("upgrades email-only profile to GitHub on first GitHub-OAuth sign-in", async () => {
    store.set(USER_ID, {
      ...makeEmailProfile(),
      displayName: "Original Name",
      bio: "I love TS.",
    });

    currentAuthUser = {
      id: USER_ID,
      email: USER_EMAIL,
      user_metadata: {
        user_name: "alexdev",
        provider_id: "1234567",
        avatar_url: "https://avatars.githubusercontent.com/u/1234567",
      },
      app_metadata: { provider: "github" },
    };

    const res = await request(app.getHttpServer())
      .get("/v1/profile/me")
      .set("Authorization", `Bearer ${TEST_JWT}`)
      .expect(200);

    expect(res.body.data).toMatchObject({
      user_id: USER_ID,
      // user-edited fields preserved
      display_name: "Original Name",
      bio: "I love TS.",
      // github-derived fields populated
      github_username: "alexdev",
      github_id: "1234567",
      avatar_url: "https://avatars.githubusercontent.com/u/1234567",
      auth_provider: "github",
    });
  });

  it("PATCH /v1/profile/me updates display_name + bio only", async () => {
    store.set(USER_ID, {
      ...makeEmailProfile(),
      githubUsername: "alexdev",
      githubId: "1234567",
      authProvider: "github",
    });

    const res = await request(app.getHttpServer())
      .patch("/v1/profile/me")
      .set("Authorization", `Bearer ${TEST_JWT}`)
      .set("Content-Type", "application/json")
      .send({
        display_name: "New Name",
        bio: "Building OpenKT.",
        // The fields below are NOT user-editable. The zod schema simply
        // drops them on the floor — PATCH ignores them rather than 400ing
        // so older clients posting full profile dumps still work.
        email: "attacker@example.com",
        github_username: "attacker",
        auth_provider: "email",
      })
      .expect(200);

    expect(res.body.data).toMatchObject({
      display_name: "New Name",
      bio: "Building OpenKT.",
      // unchanged
      email: USER_EMAIL,
      github_username: "alexdev",
      auth_provider: "github",
    });
  });
});
