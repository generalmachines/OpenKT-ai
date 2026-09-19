import { describe, expect, it } from "vitest";
import { shouldAbstain } from "../src/abstain.js";

describe("shouldAbstain", () => {
  it("an empty list abstains", () => {
    expect(shouldAbstain([])).toBe(true);
  });

  it("rerank 0.19 → true; exactly 0.20 → false", () => {
    expect(shouldAbstain([{ rerank: 0.19 }, { rerank: 0.05 }])).toBe(true);
    expect(shouldAbstain([{ rerank: 0.2 }])).toBe(false);
  });

  it("no rerank: similarity 0.29 → true; exactly 0.30 → false", () => {
    expect(shouldAbstain([{ similarity: 0.29 }])).toBe(true);
    expect(shouldAbstain([{ similarity: 0.3 }])).toBe(false);
  });

  it("rerank present on one item only → the rerank rule decides", () => {
    // The high similarity would pass the cosine rule; the low rerank abstains.
    expect(shouldAbstain([{ similarity: 0.9 }, { rerank: 0.1 }])).toBe(true);
    // And a passing rerank overrides a hopeless similarity.
    expect(shouldAbstain([{ similarity: 0.1 }, { rerank: 0.5 }])).toBe(false);
  });

  it("items with neither field → true", () => {
    expect(shouldAbstain([{}, {}])).toBe(true);
    // A single item with no scores at all also has max(...) = 0.
    expect(shouldAbstain([{ similarity: undefined }])).toBe(true);
  });

  it("the best item decides — one strong match saves the list", () => {
    expect(shouldAbstain([{ similarity: 0.1 }, { similarity: 0.42 }])).toBe(false);
    expect(shouldAbstain([{ rerank: 0.01 }, { rerank: 0.31 }])).toBe(false);
  });
});
