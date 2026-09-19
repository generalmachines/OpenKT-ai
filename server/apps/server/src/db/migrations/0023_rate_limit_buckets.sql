-- Postgres-backed token-bucket rate limiter.
--
-- One row per bucket_key (e.g. "user:<uuid>:memory_create",
-- "ip:1.2.3.4:auth_signup"). The acquire() flow is a single atomic
-- UPDATE … RETURNING which both refills (tokens += elapsed *
-- refill_rate_per_sec, capped at capacity) and consumes 1 token.
-- If consumed returns < 1 we 429 the caller with a Retry-After hint.

CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "bucket_key"          text PRIMARY KEY,
  "tokens"              numeric NOT NULL,
  "capacity"            numeric NOT NULL,
  "refill_rate_per_sec" numeric NOT NULL,
  "last_refill"         timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
