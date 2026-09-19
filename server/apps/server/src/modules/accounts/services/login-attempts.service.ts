import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { loginAttempts } from "../../../db/schema";

// Brute-force brake for the public sign-in routes. Two kinds of row in
// `login_attempts`, counted separately:
//
//   failure — a FAILED login / Google sign-in / password change. At most
//             10 per email and 100 per IP address in 15 minutes.
//   signup  — a sign-up with an acceptable password. At most 300 per IP
//             address in an hour; never counted against the email.
//
// Successful logins and sign-ups do not use up anyone's failure budget, so a
// room full of people behind one venue Wi-Fi address can all sign up and sign
// in. The per-IP numbers are configurable (OPENKT_AUTH_*), the per-email
// failure limit is the brake on password guessing.
//
// The refusal is deliberately the same sentence whatever tripped it — it never
// says whether the email exists, or which limit was hit.
export type AttemptKind = "failure" | "signup";

export interface AttemptLimits {
  failuresPerEmail: number;
  failuresPerIp: number;
  signupsPerIp: number;
}

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = { failuresPerEmail: 10, failuresPerIp: 100, signupsPerIp: 300 };
export const FAILURE_WINDOW_MINUTES = 15;
export const SIGNUP_WINDOW_MINUTES = 60;
export const RATE_LIMIT_MESSAGE = "too many attempts — wait a few minutes and try again";

@Injectable()
export class LoginAttemptsService {
  readonly limits: AttemptLimits;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    config: ConfigService,
  ) {
    this.limits = {
      failuresPerEmail: positive(config.get("OPENKT_AUTH_MAX_FAILED_LOGINS_PER_EMAIL"), DEFAULT_ATTEMPT_LIMITS.failuresPerEmail),
      failuresPerIp: positive(config.get("OPENKT_AUTH_MAX_FAILED_LOGINS_PER_IP"), DEFAULT_ATTEMPT_LIMITS.failuresPerIp),
      signupsPerIp: positive(config.get("OPENKT_AUTH_MAX_SIGNUPS_PER_IP"), DEFAULT_ATTEMPT_LIMITS.signupsPerIp),
    };
  }

  // Before a login, Google sign-in or password change: throws 429
  // `rate_limited` when the email or the IP has used up its failure budget.
  async assertAllowed(email: string | null, ip: string | null): Promise<void> {
    const result = await this.db.execute(sql`
      select
        (select count(*) from login_attempts
          where ${email}::text is not null and email = ${email} and kind = 'failure'
            and at > now() - make_interval(mins => ${FAILURE_WINDOW_MINUTES}))::int as by_email,
        (select count(*) from login_attempts
          where ${ip}::text is not null and ip = ${ip} and kind = 'failure'
            and at > now() - make_interval(mins => ${FAILURE_WINDOW_MINUTES}))::int as by_ip
    `);
    const row = (result.rows?.[0] ?? {}) as { by_email?: number; by_ip?: number };
    if ((row.by_email ?? 0) >= this.limits.failuresPerEmail || (row.by_ip ?? 0) >= this.limits.failuresPerIp) {
      throw refusal(FAILURE_WINDOW_MINUTES);
    }
  }

  // Before a sign-up: throws 429 `rate_limited` when the IP has made too many
  // sign-ups in the last hour (account farming, or probing who has an account).
  async assertSignupAllowed(ip: string | null): Promise<void> {
    if (!ip) return;
    const result = await this.db.execute(sql`
      select count(*)::int as by_ip from login_attempts
        where ip = ${ip} and kind = 'signup'
          and at > now() - make_interval(mins => ${SIGNUP_WINDOW_MINUTES})
    `);
    const row = (result.rows?.[0] ?? {}) as { by_ip?: number };
    if ((row.by_ip ?? 0) >= this.limits.signupsPerIp) throw refusal(SIGNUP_WINDOW_MINUTES);
  }

  // A failed login / Google sign-in / password change.
  async record(email: string | null, ip: string | null): Promise<void> {
    await this.insert("failure", email, ip);
  }

  // A sign-up that got past the password rules, successful or not. The email
  // is kept for the audit trail only; it never counts against that email.
  async recordSignup(email: string | null, ip: string | null): Promise<void> {
    await this.insert("signup", email, ip);
  }

  private async insert(kind: AttemptKind, email: string | null, ip: string | null): Promise<void> {
    await this.db.insert(loginAttempts).values({ email, ip, kind });
    // Nothing reads rows older than the longest window; sweep day-old ones now
    // and then instead of running a cron for a table this small.
    if (Math.random() < 0.02) {
      await this.db.execute(sql`delete from login_attempts where at < now() - interval '1 day'`).catch(() => undefined);
    }
  }
}

function refusal(windowMinutes: number): HttpException {
  return new HttpException(
    { code: "rate_limited", message: RATE_LIMIT_MESSAGE, retry_after_seconds: windowMinutes * 60 },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function positive(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
