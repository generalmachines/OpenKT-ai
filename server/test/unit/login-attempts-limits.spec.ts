// Sign-in limits: failed logins per email and per IP, sign-ups per IP, each
// configurable, each refused with the same generic 429.

import { HttpException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import type { DrizzleDb } from "../../apps/server/src/db/drizzle.module";
import {
  DEFAULT_ATTEMPT_LIMITS,
  LoginAttemptsService,
  RATE_LIMIT_MESSAGE,
} from "../../apps/server/src/modules/accounts/services/login-attempts.service";

function config(values: Record<string, unknown> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

// A database whose count query answers with the given row.
function db(row: Record<string, number>): DrizzleDb {
  return { execute: async () => ({ rows: [row] }) } as unknown as DrizzleDb;
}

async function refusal(promise: Promise<void>): Promise<{ status: number; body: unknown } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return { status: err.getStatus(), body: err.getResponse() };
  }
}

describe("LoginAttemptsService limits", () => {
  it("defaults: 10 failed logins per email, 100 per IP, 300 sign-ups per IP", () => {
    const service = new LoginAttemptsService(db({}), config());
    expect(service.limits).toEqual({ failuresPerEmail: 10, failuresPerIp: 100, signupsPerIp: 300 });
    expect(DEFAULT_ATTEMPT_LIMITS).toEqual(service.limits);
  });

  it("reads OPENKT_AUTH_* overrides, as numbers or strings; ignores nonsense", () => {
    const service = new LoginAttemptsService(
      db({}),
      config({
        OPENKT_AUTH_MAX_FAILED_LOGINS_PER_EMAIL: 5,
        OPENKT_AUTH_MAX_FAILED_LOGINS_PER_IP: "40",
        OPENKT_AUTH_MAX_SIGNUPS_PER_IP: "0",
      }),
    );
    expect(service.limits).toEqual({ failuresPerEmail: 5, failuresPerIp: 40, signupsPerIp: 300 });
  });

  it("failed logins per email: 9 → allowed, 10 → refused", async () => {
    await expect(refusal(new LoginAttemptsService(db({ by_email: 9, by_ip: 0 }), config()).assertAllowed("a@b.co", "1.2.3.4"))).resolves.toBeNull();
    const refused = await refusal(new LoginAttemptsService(db({ by_email: 10, by_ip: 0 }), config()).assertAllowed("a@b.co", "1.2.3.4"));
    expect(refused).toEqual({
      status: 429,
      body: { code: "rate_limited", message: RATE_LIMIT_MESSAGE, retry_after_seconds: 900 },
    });
  });

  it("failed logins per IP: 99 → allowed, 100 → refused with the same body", async () => {
    await expect(refusal(new LoginAttemptsService(db({ by_email: 0, by_ip: 99 }), config()).assertAllowed("a@b.co", "1.2.3.4"))).resolves.toBeNull();
    const refused = await refusal(new LoginAttemptsService(db({ by_email: 0, by_ip: 100 }), config()).assertAllowed("a@b.co", "1.2.3.4"));
    expect(refused).toEqual({
      status: 429,
      body: { code: "rate_limited", message: RATE_LIMIT_MESSAGE, retry_after_seconds: 900 },
    });
  });

  it("sign-ups per IP: 299 → allowed, 300 → refused, same message", async () => {
    await expect(refusal(new LoginAttemptsService(db({ by_ip: 299 }), config()).assertSignupAllowed("1.2.3.4"))).resolves.toBeNull();
    const refused = await refusal(new LoginAttemptsService(db({ by_ip: 300 }), config()).assertSignupAllowed("1.2.3.4"));
    expect(refused).toEqual({
      status: 429,
      body: { code: "rate_limited", message: RATE_LIMIT_MESSAGE, retry_after_seconds: 3600 },
    });
  });

  it("a sign-up with no known address is not limited by address", async () => {
    const service = new LoginAttemptsService(db({ by_ip: 10_000 }), config());
    await expect(refusal(service.assertSignupAllowed(null))).resolves.toBeNull();
  });
});
