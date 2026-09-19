import { describe, expect, it } from "vitest";
import { fuse } from "../src/fuse.js";
import { InvalidInputError } from "../src/index.js";
import type { Candidate } from "../src/types.js";

function candidate(overrides: Partial<Candidate> & { id: string }): Candidate {
  return {
    type: "fact",
    text: `text for ${overrides.id}`,
    project_id: "p1",
    session_id: "s1",
    cites: [],
    created_at: "2026-01-01T00:00:00Z",
    is_pinned: false,
    locked: false,
    recalls_30d_unused: 0,
    ranks: {},
    scope: "S3",
    ...overrides,
  };
}

describe("fuse", () => {
  it("vector rank 1 only gives fused = 1/61", () => {
    const out = fuse([candidate({ id: "a", ranks: { vector: 1 } })]);
    expect(out[0]?.fused).toBeCloseTo(1 / 61);
  });

  it("vector 1 + keyword 1 gives 2/61 and sorts above vector-only rank 1", () => {
    const out = fuse([
      candidate({ id: "a", ranks: { vector: 1 } }),
      candidate({ id: "b", ranks: { vector: 1, keyword: 1 } }),
    ]);
    expect(out[0]?.fused).toBeCloseTo(2 / 61);
    expect(out[0]?.id).toBe("b");
    expect(out[1]?.fused).toBeCloseTo(1 / 61);
  });

  it("vector 3 + keyword 10 gives 1/63 + 1/70", () => {
    const out = fuse([candidate({ id: "a", ranks: { vector: 3, keyword: 10 } })]);
    expect(out[0]?.fused).toBeCloseTo(1 / 63 + 1 / 70);
  });

  it("breaks ties by id ascending", () => {
    const c = { ranks: { vector: 5 } };
    const out = fuse([candidate({ id: "zeta", ...c }), candidate({ id: "alpha", ...c })]);
    expect(out.map((i) => i.id)).toEqual(["alpha", "zeta"]);
  });

  it("does not mutate the input array or its items", () => {
    const input = [
      candidate({ id: "b", ranks: { vector: 2 } }),
      candidate({ id: "a", ranks: { vector: 1, keyword: 4 } }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    fuse(input);
    expect(input).toEqual(snapshot);
  });

  it("throws InvalidInputError for rank 0", () => {
    expect(() => fuse([candidate({ id: "a", ranks: { vector: 0 } })])).toThrow(
      InvalidInputError,
    );
  });

  it("throws InvalidInputError for a non-integer rank", () => {
    expect(() => fuse([candidate({ id: "a", ranks: { keyword: 1.5 } })])).toThrow(
      InvalidInputError,
    );
  });

  it("throws InvalidInputError for an item with empty ranks", () => {
    expect(() => fuse([candidate({ id: "a", ranks: {} })])).toThrow(InvalidInputError);
  });

  it("accepts a custom k", () => {
    const out = fuse([candidate({ id: "a", ranks: { vector: 1 } })], 10);
    expect(out[0]?.fused).toBeCloseTo(1 / 11);
  });
});
