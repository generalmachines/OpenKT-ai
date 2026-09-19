import { describe, expect, it } from "vitest";
import { capFacts } from "../src/caps.js";
import type { Kind } from "../src/types.js";

function facts(kinds: Kind[]): { kind: Kind; id: number }[] {
  return kinds.map((kind, i) => ({ kind, id: i }));
}

describe("capFacts", () => {
  it("keeps original order when the same object appears twice", () => {
    const a = { kind: "idea" as Kind, n: "a" };
    const b = { kind: "decision" as Kind, n: "b" };
    const c = { kind: "idea" as Kind, n: "c" };
    expect(capFacts([a, b, a, c], 3).map((f) => f.n)).toEqual(["a", "b", "a"]);
  });

  it("keeps 12 of 15 facts, removing the last three ideas, order preserved", () => {
    // 5 decisions, 5 facts, 5 ideas. Decisions and facts outrank ideas, so
    // exactly the last three ideas are dropped.
    const input = facts([
      "decision", "idea", "fact", "decision", "idea",
      "fact", "decision", "idea", "fact", "decision",
      "idea", "fact", "decision", "idea", "fact",
    ]);
    const out = capFacts(input, 12);
    expect(out).toHaveLength(12);
    expect(out.filter((f) => f.kind === "idea")).toHaveLength(2);
    // Original relative order preserved.
    const ids = out.map((f) => f.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    // The kept ideas are the first two in original order.
    expect(out.filter((f) => f.kind === "idea").map((f) => f.id)).toEqual([1, 4]);
  });

  it("picks by KIND_PRIORITY when kinds compete for the cap", () => {
    const input = facts(["idea", "decision", "fact"]);
    expect(capFacts(input, 1).map((f) => f.kind)).toEqual(["decision"]);
  });

  it("returns the input unchanged when under the cap", () => {
    const input = facts(["idea"]);
    expect(capFacts(input, 12)).toBe(input);
  });
});
