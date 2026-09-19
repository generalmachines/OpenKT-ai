// Unit tests for the WorkerTagMatcherService dedup logic (Enhancement 1).
//
// The matcher serves two responsibilities:
//   1. Normalize the LLM-emitted slug strings (lowercase, collapse
//      whitespace + underscores + hyphens) so syntactically-different
//      spellings of the same tag don't fan out into N rows.
//   2. Embedding-based dedup — for slugs that don't exact-match a
//      normalized existing tag, check if any existing tag's embedding
//      is within OPENKT_TAG_DEDUP_SIMILARITY of the new tag's
//      embedding; reuse that tag id if so.
//
// We stub the BGE/OpenAI embedder by setting OPENKT_EMBEDDING_BACKEND=bge
// and stubbing global.fetch to return a deterministic 1024-dim vector.

import {
  WorkerTagMatcherService,
  normalizeTagSlug,
} from "../../apps/worker/src/modules/memory-engine/services/worker-tag-matcher.service";

interface PgCall {
  sql: string;
  params: unknown[];
}

class FakePg {
  public calls: PgCall[] = [];
  public oneResults: Array<unknown> = [];

  async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, params });
    const next = this.oneResults.shift();
    return (next as T | undefined) ?? null;
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, params });
    return [];
  }

  findCall(needle: string): PgCall | undefined {
    return this.calls.find((c) => c.sql.includes(needle));
  }
  findAllCalls(needle: string): PgCall[] {
    return this.calls.filter((c) => c.sql.includes(needle));
  }
}

describe("normalizeTagSlug", () => {
  it("lowercases input", () => {
    expect(normalizeTagSlug("RabbitMQ")).toBe("rabbitmq");
  });
  it("trims whitespace", () => {
    expect(normalizeTagSlug("  rabbit-mq  ")).toBe("rabbit-mq");
  });
  it("replaces internal whitespace with a single hyphen", () => {
    expect(normalizeTagSlug("rabbit mq")).toBe("rabbit-mq");
    expect(normalizeTagSlug("rabbit   mq")).toBe("rabbit-mq");
  });
  it("replaces underscores with hyphens", () => {
    expect(normalizeTagSlug("rabbit_mq")).toBe("rabbit-mq");
  });
  it("collapses repeated hyphens and underscores into one hyphen", () => {
    expect(normalizeTagSlug("rabbit--mq")).toBe("rabbit-mq");
    expect(normalizeTagSlug("rabbit__mq")).toBe("rabbit-mq");
    expect(normalizeTagSlug("rabbit-_-mq")).toBe("rabbit-mq");
  });
  it("strips leading and trailing hyphens", () => {
    expect(normalizeTagSlug("-rabbit-mq-")).toBe("rabbit-mq");
  });
});

describe("WorkerTagMatcherService — generic normalization dedup", () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_BACKEND = process.env.OPENKT_EMBEDDING_BACKEND;
  const ORIGINAL_THRESHOLD = process.env.OPENKT_TAG_DEDUP_SIMILARITY;

  beforeAll(() => {
    process.env.OPENKT_EMBEDDING_BACKEND = "bge";
  });
  afterAll(() => {
    if (ORIGINAL_BACKEND === undefined) {
      delete process.env.OPENKT_EMBEDDING_BACKEND;
    } else {
      process.env.OPENKT_EMBEDDING_BACKEND = ORIGINAL_BACKEND;
    }
    if (ORIGINAL_THRESHOLD === undefined) {
      delete process.env.OPENKT_TAG_DEDUP_SIMILARITY;
    } else {
      process.env.OPENKT_TAG_DEDUP_SIMILARITY = ORIGINAL_THRESHOLD;
    }
    global.fetch = ORIGINAL_FETCH;
  });

  beforeEach(() => {
    const vector = new Array(1024).fill(0).map((_, i) => i / 1024);
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify([vector]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
  });

  it("maps 'RabbitMQ', 'rabbitmq', and 'rabbit_mq' to the same existing tag id via embedding similarity ≥ 0.85", async () => {
    const TAG_ID = "00000000-0000-0000-0000-0000000000aa";
    const pg = new FakePg();
    // For each of the 3 candidates, queue: (1) embedding-sim lookup
    // returns the same existing tag with similarity 0.94 (above the
    // 0.85 threshold). The slug-exact path is never reached because
    // the embedding path resolves first.
    for (let i = 0; i < 3; i++) {
      pg.oneResults.push({
        id: TAG_ID,
        slug: "rabbitmq",
        similarity: 0.94,
      });
    }

    const matcher = new WorkerTagMatcherService(pg as never);
    const result = await matcher.match({
      orgId: null,
      ownerUserId: "00000000-0000-0000-0000-0000000000bb",
      candidates: [
        { slug: "RabbitMQ", displayName: "RabbitMQ" },
        { slug: "rabbitmq", displayName: "Rabbitmq" },
        { slug: "rabbit_mq", displayName: "Rabbit Mq" },
      ],
    });

    expect(result.tagIds).toEqual([TAG_ID]);
    expect(result.resolutions).toHaveLength(3);
    expect(result.resolutions.every((r) => r.tagId === TAG_ID)).toBe(true);
    expect(result.resolutions.every((r) => r.matchedExisting)).toBe(true);
    expect(result.resolutions.every((r) => (r.similarity ?? 0) >= 0.85)).toBe(true);
    // Each candidate went through the embedding-similarity lookup
    // (3 calls), never through the insert path.
    expect(pg.findAllCalls("from tags")).toHaveLength(3);
    expect(pg.findCall("insert into tags")).toBeUndefined();
  });

  it("falls back to slug-exact lookup when embedding similarity is below threshold", async () => {
    const TAG_ID = "00000000-0000-0000-0000-0000000000aa";
    const pg = new FakePg();
    // First .one(): embedding lookup returns 0.40 — below threshold,
    // so we fall through to the slug-exact lookup.
    pg.oneResults.push({ id: "other", slug: "different", similarity: 0.4 });
    // Second .one(): slug-exact lookup hits an existing row.
    pg.oneResults.push({ id: TAG_ID, slug: "rabbitmq" });

    const matcher = new WorkerTagMatcherService(pg as never);
    const result = await matcher.match({
      orgId: null,
      ownerUserId: "00000000-0000-0000-0000-0000000000bb",
      candidates: [{ slug: "RabbitMQ", displayName: "RabbitMQ" }],
    });

    expect(result.tagIds).toEqual([TAG_ID]);
    expect(result.resolutions[0].tagId).toBe(TAG_ID);
    expect(result.resolutions[0].normalized).toBe("rabbitmq");
    expect(result.resolutions[0].matchedExisting).toBe(true);
    expect(result.resolutions[0].similarity).toBeNull();
  });

  it("inserts a new tag row when neither embedding nor slug-exact match resolves", async () => {
    const NEW_TAG_ID = "00000000-0000-0000-0000-0000000000cc";
    const pg = new FakePg();
    // First .one(): embedding lookup — no candidate above threshold.
    pg.oneResults.push({ id: "other", slug: "different", similarity: 0.2 });
    // Second .one(): slug-exact lookup returns null.
    pg.oneResults.push(null);
    // Third .one(): insert returning a new id.
    pg.oneResults.push({ id: NEW_TAG_ID, slug: "rabbitmq" });

    const matcher = new WorkerTagMatcherService(pg as never);
    const result = await matcher.match({
      orgId: null,
      ownerUserId: "00000000-0000-0000-0000-0000000000bb",
      candidates: [{ slug: "RabbitMQ", displayName: "RabbitMQ" }],
    });

    expect(result.tagIds).toEqual([NEW_TAG_ID]);
    expect(result.resolutions[0].tagId).toBe(NEW_TAG_ID);
    expect(result.resolutions[0].matchedExisting).toBe(false);
    expect(pg.findCall("insert into tags")).toBeDefined();
  });

  it("honors OPENKT_TAG_DEDUP_SIMILARITY when set", async () => {
    const TAG_ID = "00000000-0000-0000-0000-0000000000aa";
    const pg = new FakePg();
    // Embedding lookup returns 0.92 — above default 0.85 but BELOW
    // our test override of 0.95.
    pg.oneResults.push({ id: TAG_ID, slug: "rabbitmq", similarity: 0.92 });
    // Falls through to slug-exact lookup, which doesn't match.
    pg.oneResults.push(null);
    // Then inserts a fresh tag.
    pg.oneResults.push({ id: "new-id", slug: "rabbitmq" });

    process.env.OPENKT_TAG_DEDUP_SIMILARITY = "0.95";
    try {
      const matcher = new WorkerTagMatcherService(pg as never);
      const result = await matcher.match({
        orgId: null,
        ownerUserId: "00000000-0000-0000-0000-0000000000bb",
        candidates: [{ slug: "RabbitMQ", displayName: "RabbitMQ" }],
      });
      expect(result.tagIds).toEqual(["new-id"]);
      expect(result.resolutions[0].matchedExisting).toBe(false);
    } finally {
      delete process.env.OPENKT_TAG_DEDUP_SIMILARITY;
    }
  });
});
