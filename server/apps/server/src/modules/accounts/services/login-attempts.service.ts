import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { loginAttempts } from "../../../db/schema";

// Brute-force brake for the public sign-in routes: at most 10 counted attempts
// per 15 minutes for an email, and the same for an IP address. What counts:
// every sign-up (with an acceptable password), every FAILED login / Google
// sign-in / password change. A
// successful login is not counted, so people behind one office address do not
// lock each other out by signing in normally.
//
// The refusal is deliberately the same sentence whatever tripped it — it never
// says whether the email exists, or which of the two limits was hit.
export const MAX_ATTEMPTS = 10;
export const WINDOW_MINUTES = 15;
export const RATE_LIMIT_MESSAGE = "too many attempts — wait a few minutes and try again";

@Injectable()
export class LoginAttemptsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Throws 429 `rate_limited` when either the email or the IP has used up its window.
  async assertAllowed(email: string | null, ip: string | null): Promise<void> {
    const result = await this.db.execute(sql`
      select
        (select count(*) from login_attempts
          where ${email}::text is not null and email = ${email}
            and at > now() - make_interval(mins => ${WINDOW_MINUTES}))::int as by_email,
        (select count(*) from login_attempts
          where ${ip}::text is not null and ip = ${ip}
            and at > now() - make_interval(mins => ${WINDOW_MINUTES}))::int as by_ip
    `);
    const row = (result.rows?.[0] ?? {}) as { by_email?: number; by_ip?: number };
    if ((row.by_email ?? 0) >= MAX_ATTEMPTS || (row.by_ip ?? 0) >= MAX_ATTEMPTS) {
      throw new HttpException(
        { code: "rate_limited", message: RATE_LIMIT_MESSAGE, retry_after_seconds: WINDOW_MINUTES * 60 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async record(email: string | null, ip: string | null): Promise<void> {
    await this.db.insert(loginAttempts).values({ email, ip });
    // Nothing reads rows older than the window; sweep day-old ones now and then
    // instead of running a cron for a table this small.
    if (Math.random() < 0.02) {
      await this.db.execute(sql`delete from login_attempts where at < now() - interval '1 day'`).catch(() => undefined);
    }
  }
}
