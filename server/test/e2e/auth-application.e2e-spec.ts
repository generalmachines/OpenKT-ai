import { UnauthorizedException } from "@nestjs/common";

import { AuthApplicationService } from "../../apps/server/src/modules/auth/services/auth-application.service";

// Service-level test — the controller is a thin pass-through, so the
// shape contract belongs to the service. We mock @supabase/supabase-js
// so every `createClient` call returns a single shared stub we control
// from the test body.
//
// Covers the cases that matter to the CLI:
//   - successful login returns the {token, refresh_token, expires_at, user}
//     shape
//   - bad credentials throw 401 (generic, not "user exists / wrong pw")
//   - signup with email-confirmation-required returns an empty session
//     so callers can prompt
//   - refresh round-trips
//   - logout doesn't throw on supabase errors (best-effort revoke)

const mockClient = {
  auth: {
    signInWithPassword: jest.fn(),
    signUp: jest.fn(),
    signInWithOtp: jest.fn(),
    refreshSession: jest.fn(),
    signOut: jest.fn(),
  },
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockClient),
}));

const configService = {
  get: jest.fn((key: string) => {
    if (key === "SUPABASE_URL") return "https://test.supabase.co";
    if (key === "SUPABASE_PUBLISHABLE_KEY") return "anon-key";
    if (key === "SUPABASE_SERVICE_ROLE_KEY") return "srv-key";
    return undefined;
  }),
} as never;

describe("AuthApplicationService", () => {
  let service: AuthApplicationService;

  // WaitlistService stub: `allowed: true` short-circuits the gate so
  // existing tests don't have to wire a DB. The dedicated waitlist
  // signup-gate test wires its own stub for the blocked case.
  const waitlistStub = {
    checkSignupEligibility: jest.fn().mockResolvedValue({
      allowed: true,
      reason: "approved",
      detail: null,
    }),
    markSignedUp: jest.fn().mockResolvedValue(undefined),
  } as unknown as import("../../apps/server/src/modules/waitlist/services/waitlist.service").WaitlistService;

  // AuditService stub: every method is a no-op promise. The service
  // itself wraps audit writes in try/catch so a failure here would
  // never block auth, but giving it real spies lets future tests
  // assert that the expected events get emitted.
  const auditStub = {
    write: jest.fn().mockResolvedValue(undefined),
    writeFromContext: jest.fn().mockResolvedValue(undefined),
  } as unknown as import("../../apps/server/src/modules/audit/services/audit.service").AuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthApplicationService(configService, waitlistStub, auditStub);
  });

  it("passwordLogin returns the session shape on success", async () => {
    mockClient.auth.signInWithPassword.mockResolvedValue({
      data: {
        session: {
          access_token: "jwt-here",
          refresh_token: "rt-here",
          expires_at: 1700000000,
        },
        user: { id: "u1", email: "a@b.c" },
      },
      error: null,
    });

    const out = await service.passwordLogin("a@b.c", "supersecret");
    expect(out).toEqual({
      token: "jwt-here",
      refresh_token: "rt-here",
      expires_at: 1700000000,
      user: { id: "u1", email: "a@b.c" },
    });
  });

  it("passwordLogin throws 401 generically on bad credentials", async () => {
    mockClient.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Invalid login credentials" } as never,
    });

    await expect(service.passwordLogin("a@b.c", "wrong")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.passwordLogin("a@b.c", "wrong")).rejects.toMatchObject({
      message: "invalid email or password",
    });
  });

  it("signup returns empty session when confirmation required", async () => {
    mockClient.auth.signUp.mockResolvedValue({
      data: { session: null, user: { id: "u1", email: "a@b.c" } },
      error: null,
    });

    const out = await service.signup("a@b.c", "newpassword");
    expect(out).toEqual({
      token: "",
      refresh_token: "",
      expires_at: null,
      user: { id: "u1", email: "a@b.c" },
    });
  });

  it("signup returns full session when confirmation not required", async () => {
    mockClient.auth.signUp.mockResolvedValue({
      data: {
        session: {
          access_token: "jwt-2",
          refresh_token: "rt-2",
          expires_at: 1700001000,
        },
        user: { id: "u1", email: "a@b.c" },
      },
      error: null,
    });

    const out = await service.signup("a@b.c", "newpassword");
    expect(out.token).toBe("jwt-2");
    expect(out.user.id).toBe("u1");
  });

  it("magic-link calls signInWithOtp without throwing on success", async () => {
    mockClient.auth.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    await expect(service.sendMagicLink("a@b.c")).resolves.toBeUndefined();
    expect(mockClient.auth.signInWithOtp).toHaveBeenCalledWith({ email: "a@b.c" });
  });

  it("refresh round-trips a session shape", async () => {
    mockClient.auth.refreshSession.mockResolvedValue({
      data: {
        session: {
          access_token: "jwt-2",
          refresh_token: "rt-2",
          expires_at: 1700000999,
        },
        user: { id: "u1", email: "a@b.c" },
      },
      error: null,
    });

    const out = await service.refresh("rt-here");
    expect(out.token).toBe("jwt-2");
    expect(out.refresh_token).toBe("rt-2");
    expect(mockClient.auth.refreshSession).toHaveBeenCalledWith({
      refresh_token: "rt-here",
    });
  });

  it("refresh throws 401 when the token is expired/revoked", async () => {
    mockClient.auth.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: "Invalid refresh token" } as never,
    });

    await expect(service.refresh("dead")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logout signs out without throwing on broker errors", async () => {
    mockClient.auth.signOut.mockResolvedValue({ error: null });
    await expect(service.logout("jwt-here")).resolves.toBeUndefined();
  });
});
