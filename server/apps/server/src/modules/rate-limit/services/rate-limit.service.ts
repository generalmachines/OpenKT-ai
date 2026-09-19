import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

export interface RateLimitAcquireResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

// Postgres token-bucket. acquire(key, capacity, refillPerSec) is one
// round-trip:
//   INSERT … ON CONFLICT DO UPDATE
//   SET tokens = LEAST(capacity, tokens + elapsed * rate) - 1,
//       last_refill = now()
//   RETURNING tokens
// If the returned tokens is < 0 we revert with a follow-up SET
// tokens = LEAST(capacity, tokens + elapsed * rate) and report
// retryAfterMs = ceil((1 - tokens) / rate).
//
// "Fail open" — any thrown error from the db is logged and the
// request is allowed through. Better to over-serve than to drop
// traffic because of a transient db hiccup.
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async acquire(
    key: string,
    capacity: number,
    refillPerSec: number,
  ): Promise<RateLimitAcquireResult> {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      return { allowed: true, remaining: Infinity };
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      return { allowed: true, remaining: Infinity };
    }

    try {
      // Atomic upsert that both refills and consumes one token. The
      // GREATEST/LEAST clamp keeps tokens within [-1, capacity] after
      // the decrement; we treat tokens < 0 as "would-have-rejected"
      // and return a Retry-After hint without actually keeping a
      // negative reservation.
      const result = await this.db.execute(sql`
        with upsert as (
          insert into rate_limit_buckets (bucket_key, tokens, capacity, refill_rate_per_sec, last_refill)
          values (${key}, ${capacity - 1}, ${capacity}, ${refillPerSec}, now())
          on conflict (bucket_key) do update
            set tokens = least(
                  rate_limit_buckets.capacity,
                  rate_limit_buckets.tokens
                    + extract(epoch from (now() - rate_limit_buckets.last_refill))
                      * rate_limit_buckets.refill_rate_per_sec
                ) - 1,
                capacity = ${capacity},
                refill_rate_per_sec = ${refillPerSec},
                last_refill = now()
          returning tokens, refill_rate_per_sec
        )
        select tokens::float8 as tokens, refill_rate_per_sec::float8 as rate
        from upsert
      `);
      const row = result.rows[0] as
        | { tokens: number; rate: number }
        | undefined;
      if (!row) return { allowed: true, remaining: capacity };

      if (row.tokens >= 0) {
        return { allowed: true, remaining: row.tokens };
      }

      // Refund the consumed token — we don't want to permanently
      // accumulate negative debt for rejected callers.
      await this.db.execute(sql`
        update rate_limit_buckets
        set tokens = least(capacity, tokens + 1)
        where bucket_key = ${key}
      `);
      const deficit = -row.tokens; // how many tokens short, before we refund
      const retryAfterMs = Math.max(1, Math.ceil((deficit / row.rate) * 1000));
      return { allowed: false, remaining: 0, retryAfterMs };
    } catch (err) {
      this.logger.warn(
        `rate-limit acquire failed (fail-open) key=${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { allowed: true, remaining: capacity };
    }
  }
}
