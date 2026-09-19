// Regression tests for os-sts1: a JS array interpolated into a drizzle
// sql`` template expands to a parenthesized param list `($1, $2, ...)`
// — a ROW/record — NOT a Postgres array. `($1,$2)::uuid[]` then fails
// server-side with `cannot cast type record to uuid[]`, which prod
// logged every 1-3 minutes from the recall → ensureNeighborsFresh path
// while the caller swallowed the error.
//
// These tests render the exact SQL the repositories hand to the driver
// (via PgDialect.sqlToQuery) and pin the ARRAY[...] per-param binding,
// so the record-cast regression cannot come back silently.

import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

// Matches the broken expansion `($1, $2)::uuid[]` / `($1, $2)::text[]`
// (two or more params — a single-param paren group is not a record).
const RECORD_CAST = /\(\$\d+(?:,\s*\$\d+)+\)::(?:uuid|text)\[\]/;

describe("MemoryRepository.ensureNeighborsFresh array binding (os-sts1)", () => {
  function makeRepo(rows: unknown[] = []) {
    const captured: unknown[] = [];
    const fakeDb = {
      execute: jest.fn(async (q: unknown) => {
        captured.push(q);
        return { rows };
      }),
    };
    const {
      MemoryRepository,
    } = require("../../apps/server/src/modules/memory/repositories/memory.repository");
    return { repo: new MemoryRepository(fakeDb), captured };
  }

  it("binds each memory id inside ARRAY[...], never a record cast", async () => {
    const { repo, captured } = makeRepo();
    const ids = [
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
      "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33",
    ];

    await repo.ensureNeighborsFresh(ids);

    expect(captured).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { sql: text, params } = dialect.sqlToQuery(captured[0] as any);

    expect(text).toContain("unnest(array[$1::uuid, $2::uuid, $3::uuid])");
    expect(text).not.toMatch(RECORD_CAST);
    expect(params).toEqual(expect.arrayContaining(ids));
  });

  it("skips the query entirely for an empty id list", async () => {
    const { repo, captured } = makeRepo();
    await repo.ensureNeighborsFresh([]);
    expect(captured).toHaveLength(0);
  });

  it("swallows query failures by design but logs at error level", async () => {
    const fakeDb = {
      execute: jest
        .fn()
        .mockRejectedValue(new Error("cannot cast type record to uuid[]")),
    };
    const {
      MemoryRepository,
    } = require("../../apps/server/src/modules/memory/repositories/memory.repository");
    const repo = new MemoryRepository(fakeDb);

    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      // Must resolve — recall never 500s on a neighbors compute failure.
      await expect(
        repo.ensureNeighborsFresh(["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"]),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = String(errorSpy.mock.calls[0][0]);
      expect(line).toContain("swallowed by design");
      expect(line).toContain("cannot cast type record to uuid[]");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("KnowledgeRepository.listForProjectByTags array binding (os-sts1)", () => {
  it("binds tag slugs inside ARRAY[...]::text[], never a record cast", async () => {
    let capturedWhere: unknown;
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(() => chain),
      where: jest.fn((w: unknown) => {
        capturedWhere = w;
        return chain;
      }),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(async () => []),
    };
    const fakeDb = { select: jest.fn(() => chain) };

    const {
      KnowledgeRepository,
    } = require("../../apps/server/src/modules/memory/repositories/knowledge.repository");
    const repo = new KnowledgeRepository(fakeDb);

    const result = await repo.listForProjectByTags(
      "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
      ["alpha", "beta"],
      5,
    );

    expect(result).toEqual([]);
    expect(capturedWhere).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { sql: text, params } = dialect.sqlToQuery(capturedWhere as any);

    expect(text).toMatch(/&& array\[\$\d+, \$\d+\]::text\[\]/);
    expect(text).not.toMatch(RECORD_CAST);
    expect(params).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("returns [] without querying when no tag slugs are supplied", async () => {
    const fakeDb = { select: jest.fn() };
    const {
      KnowledgeRepository,
    } = require("../../apps/server/src/modules/memory/repositories/knowledge.repository");
    const repo = new KnowledgeRepository(fakeDb);

    await expect(repo.listForProjectByTags("p", [], 5)).resolves.toEqual([]);
    expect(fakeDb.select).not.toHaveBeenCalled();
  });
});
