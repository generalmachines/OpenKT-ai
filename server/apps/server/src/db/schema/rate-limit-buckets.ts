import { numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// rate_limit_buckets — one row per bucket key (e.g. "user:<uuid>:memory_create").
// The acquire() flow does a single atomic UPDATE … RETURNING that
// refills + consumes, so concurrent callers serialize on the row.
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  tokens: numeric("tokens").notNull(),
  capacity: numeric("capacity").notNull(),
  refillRatePerSec: numeric("refill_rate_per_sec").notNull(),
  lastRefill: timestamp("last_refill", { withTimezone: true }).notNull().defaultNow(),
});

export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucket = typeof rateLimitBuckets.$inferInsert;
