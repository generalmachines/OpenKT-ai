import { RateLimitService } from "../../apps/server/src/modules/rate-limit/services/rate-limit.service";

// In-memory token-bucket fake — mirrors the SQL in
// RateLimitService.acquire() so we can verify bucket math + refill
// timing without a running Postgres.
//
// The real service hits Drizzle. We stub Drizzle's `db.execute(sql\`...\`)`
// with a tiny dispatcher: the upsert returns the new tokens reading
// (which has already been decremented + refilled), and the follow-up
// `update … tokens = least(...)` (the refund on rejection) increments
// the row back up.

interface Bucket {
  tokens: number;
  capacity: number;
  rate: number;
  lastRefill: number;
}

class FakeNow {
  current = 1_700_000_000_000;
  advance(ms: number): void {
    this.current += ms;
  }
}

function makeFakeDb(buckets: Map<string, Bucket>, now: FakeNow) {
  return {
    execute: jest.fn(async (statement: unknown) => {
      const text = stringify(statement);
      const values = collectValues(statement);
      if (text.includes("insert into rate_limit_buckets")) {
        const [key, initialTokens, capacity, rate] = values as [string, number, number, number];
        const existing = buckets.get(key);
        if (!existing) {
          const created: Bucket = {
            tokens: initialTokens,
            capacity,
            rate,
            lastRefill: now.current,
          };
          buckets.set(key, created);
          return { rows: [{ tokens: created.tokens, rate: created.rate }] };
        }
        const elapsedSec = Math.max(0, (now.current - existing.lastRefill) / 1000);
        const refilled = Math.min(existing.capacity, existing.tokens + elapsedSec * existing.rate);
        const after = refilled - 1;
        existing.tokens = after;
        existing.capacity = capacity;
        existing.rate = rate;
        existing.lastRefill = now.current;
        return { rows: [{ tokens: after, rate: existing.rate }] };
      }
      if (text.includes("update rate_limit_buckets")) {
        const [key] = values as [string];
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
        }
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

function stringify(statement: unknown): string {
  if (!statement || typeof statement !== "object") return String(statement);
  const direct = (statement as { sql?: unknown }).sql;
  if (typeof direct === "string") return direct;
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in (chunk as object)) {
        const v = (chunk as { value: unknown }).value;
        return Array.isArray(v) ? v.join(" ") : String(v ?? "");
      }
      return "";
    })
    .join(" ");
}

function collectValues(statement: unknown): unknown[] {
  if (!statement || typeof statement !== "object") return [];
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return [];
  const values: unknown[] = [];
  for (const chunk of chunks) {
    // Drizzle interleaves raw SQL text (objects with `.value` set to a
    // string array of literal segments) with the interpolated bind
    // values (passed through as the bare primitive / object the caller
    // supplied). We want the latter — everything that is not a "value"
    // object is treated as a bind value.
    if (chunk && typeof chunk === "object" && "value" in (chunk as object)) {
      continue;
    }
    values.push(chunk);
  }
  return values;
}

describe("RateLimitService (unit)", () => {
  it("allows first N=capacity calls then rejects with retryAfterMs", async () => {
    const buckets = new Map<string, Bucket>();
    const now = new FakeNow();
    const db = makeFakeDb(buckets, now);
    const service = new RateLimitService(db as never);

    // capacity=3, 1 token/sec
    const r1 = await service.acquire("test:k1", 3, 1);
    const r2 = await service.acquire("test:k1", 3, 1);
    const r3 = await service.acquire("test:k1", 3, 1);
    const r4 = await service.acquire("test:k1", 3, 1);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills tokens at refillPerSec rate", async () => {
    const buckets = new Map<string, Bucket>();
    const now = new FakeNow();
    const db = makeFakeDb(buckets, now);
    const service = new RateLimitService(db as never);

    // Drain bucket (capacity=2, 1 token/sec)
    await service.acquire("test:k2", 2, 1);
    await service.acquire("test:k2", 2, 1);
    const rejected = await service.acquire("test:k2", 2, 1);
    expect(rejected.allowed).toBe(false);

    // Advance 2 seconds → should be refilled to 2, consuming back to 1
    now.advance(2_000);
    const allowedAfter = await service.acquire("test:k2", 2, 1);
    expect(allowedAfter.allowed).toBe(true);
  });

  it("fails open on db errors", async () => {
    const throwingDb = {
      execute: jest.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const service = new RateLimitService(throwingDb as never);
    const result = await service.acquire("test:k3", 1, 1);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed=true for non-positive capacity (effectively disabled)", async () => {
    const db = makeFakeDb(new Map(), new FakeNow());
    const service = new RateLimitService(db as never);
    const result = await service.acquire("test:k4", 0, 1);
    expect(result.allowed).toBe(true);
  });
});
