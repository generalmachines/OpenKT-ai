// Unit tests for the neighbors application + repository surface. We
// avoid spinning up Nest — the repo uses Drizzle's `db.execute(sql\`\`)`
// which is easy to stub directly.

import type {
  MemoryNeighborRecord,
} from "../../apps/server/src/modules/memory/contracts/memory.contract";

describe("MemoryRepository.neighbors", () => {
  it("orders by similarity desc, applies min_similarity, hydrates tags + preview", async () => {
    // Stub Drizzle's `.execute(sql\`...\`)` API. The repo also calls
    // `.select().from().innerJoin().where()` via hydrateTags; for that
    // we stub the smallest surface that returns the right rows.
    const executeCalls: Array<{ query: string }> = [];
    const fakeDb = {
      execute: jest.fn(async (q: unknown) => {
        // Drizzle's SqlQuery has .queryChunks but the simplest signal
        // is the string form which jest-mock toString gives us.
        executeCalls.push({ query: String(q) });
        return {
          rows: [
            {
              id: "mem-b",
              kind: "note",
              content_preview: "this is memory B content",
              similarity: 0.91,
              computed_at: "2026-05-14T01:00:00.000Z",
            },
            {
              id: "mem-c",
              kind: "decision",
              content_preview: "this is memory C content",
              similarity: 0.78,
              computed_at: "2026-05-14T01:00:00.000Z",
            },
          ],
        };
      }),
      // hydrateTags chain: select().from(memoryTags).innerJoin(tags).where()
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(async () => [
              {
                memoryId: "mem-b",
                id: "tag-1",
                slug: "tagged",
                displayName: "tagged",
              },
            ]),
          })),
        })),
      })),
    };

    const {
      MemoryRepository,
    } = require("../../apps/server/src/modules/memory/repositories/memory.repository");

    const repo = new MemoryRepository(fakeDb);
    const result: MemoryNeighborRecord[] = await repo.neighbors("mem-a", 10, 0.5);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("mem-b");
    expect(result[0].similarity).toBeCloseTo(0.91, 5);
    expect(result[0].kind).toBe("note");
    expect(result[0].content_preview).toContain("this is memory B content");
    expect(result[0].tags).toEqual([{ id: "tag-1", slug: "tagged", display_name: "tagged" }]);
    expect(result[1].id).toBe("mem-c");
    expect(result[1].tags).toEqual([]);

    // The repo issued exactly one .execute (for the neighbors join) —
    // the hydrate path is the drizzle chain mock above.
    expect(fakeDb.execute).toHaveBeenCalledTimes(1);
  });

  it("returns [] when the stage hasn't yet run", async () => {
    const fakeDb = {
      execute: jest.fn(async () => ({ rows: [] })),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(async () => []),
          })),
        })),
      })),
    };
    const {
      MemoryRepository,
    } = require("../../apps/server/src/modules/memory/repositories/memory.repository");

    const repo = new MemoryRepository(fakeDb);
    const result = await repo.neighbors("mem-a", 10, 0.5);
    expect(result).toEqual([]);
  });
});

describe("MemoryRecord toRecord — decay fields are present", () => {
  it("includes importance_now and decay_state on every shaped record", async () => {
    const {
      MemoryRepository,
    } = require("../../apps/server/src/modules/memory/repositories/memory.repository");

    // We invoke the private toRecord method through findById's row
    // shape. Cheapest path: stub the .select chain to return one row
    // and the hydrateTags chain to return empty tags.
    const memoryRow = {
      id: "mem-a",
      orgId: null,
      projectId: "proj-1",
      ownerUserId: "user-1",
      content: "hi",
      kind: "note",
      category: null,
      visibility: "project",
      confidence: 0.9,
      importance: 0.8,
      decayLambda: 0.01,
      // 100 days ago — exp(-0.01 * 100) ≈ 0.367879
      importanceAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      recallCount: 0,
      lastRecallAt: null,
      sourceRefs: [],
      supersededBy: null,
      archived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let selectCallCount = 0;
    const fakeDb = {
      select: jest.fn(() => {
        selectCallCount += 1;
        if (selectCallCount === 1) {
          // First select chain — findById main row
          return {
            from: jest.fn(() => ({
              innerJoin: jest.fn(() => ({
                leftJoin: jest.fn(() => ({
                  where: jest.fn(() => ({
                    limit: jest.fn(async () => [
                      {
                        m: memoryRow,
                        projectSlug: "p",
                        projectName: "p",
                        projectVisibility: "personal",
                        ownerEmail: null,
                        ownerDisplayName: null,
                      },
                    ]),
                  })),
                })),
              })),
            })),
          };
        }
        // hydrateTags
        return {
          from: jest.fn(() => ({
            innerJoin: jest.fn(() => ({
              where: jest.fn(async () => []),
            })),
          })),
        };
      }),
      execute: jest.fn(),
    };

    const repo = new MemoryRepository(fakeDb);
    const record = await repo.findById({} as never, "mem-a");
    expect(record).not.toBeNull();
    // importance_now should be ~0.8 * e^(-1) ≈ 0.294
    expect(record!.importance_now).toBeGreaterThan(0.27);
    expect(record!.importance_now).toBeLessThan(0.32);
    // 0.294 falls in the "decaying" band (>= 0.15, < 0.4)
    expect(record!.decay_state).toBe("decaying");
    // And the raw input fields are still present (additive change).
    expect(record!.importance).toBe(0.8);
    expect(record!.decay_lambda).toBe(0.01);
  });
});
