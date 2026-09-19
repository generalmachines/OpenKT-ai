import { describe, expect, it } from "vitest";
import { RECALL } from "../src/constants.js";
import { applyWeights } from "../src/weights.js";
import type { Candidate, Scope } from "../src/types.js";

const NOW = new Date("2026-09-19T12:00:00Z");

function candidate(overrides?: Partial<Candidate> & { fused?: number }) {
  const { fused = 0.01, ...rest } = overrides ?? {};
  return {
    id: "c1",
    type: "fact" as const,
    text: "some fact",
    project_id: "p1",
    cites: [],
    created_at: "2026-09-19T12:00:00Z",
    is_pinned: false,
    locked: false,
    recalls_30d_unused: 0,
    ranks: { vector: 1 },
    scope: "S3" as Scope,
    fused,
    ...rest,
  };
}

describe("applyWeights", () => {
  it("a brand-new S3 fact, not pinned, 0 unused recalls: weighted = fused", () => {
    const out = applyWeights([candidate({ fused: 0.02 })], NOW);
    expect(out[0]?.weighted).toBeCloseTo(0.02, 12);
  });

  it("aged 90 days: recency = 0.85 + 0.15/e", () => {
    const out = applyWeights(
      [candidate({ created_at: "2026-06-21T12:00:00Z" })], // exactly 90 days earlier
      NOW,
    );
    const expected = 0.01 * (0.85 + 0.15 / Math.E);
    expect(out[0]?.weighted).toBeCloseTo(expected, 12);
  });

  it("a created_at in the future is treated as age 0", () => {
    const out = applyWeights([candidate({ created_at: "2027-01-01T00:00:00Z" })], NOW);
    expect(out[0]?.weighted).toBeCloseTo(0.01, 12);
  });

  it("S0 beats S2 beats S1 beats S3 for otherwise identical items", () => {
    const items = (["S3", "S1", "S2", "S0"] as Scope[]).map((scope, i) =>
      candidate({ id: `c${i}`, scope }),
    );
    const order = applyWeights(items, NOW).map((c) => c.scope);
    expect(order).toEqual(["S0", "S2", "S1", "S3"]);
  });

  it("a section beats an identical fact", () => {
    const out = applyWeights(
      [candidate({ id: "fact", type: "fact" }), candidate({ id: "section", type: "section" })],
      NOW,
    );
    expect(out[0]?.type).toBe("section");
    expect(out[1]?.weighted).toBeCloseTo(out[0]!.weighted / RECALL.sectionBoost, 12);
  });

  it("pinned and locked boosts multiply in", () => {
    const plain = applyWeights([candidate()], NOW)[0]!.weighted;
    const pinned = applyWeights([candidate({ is_pinned: true })], NOW)[0]!.weighted;
    const locked = applyWeights([candidate({ locked: true })], NOW)[0]!.weighted;
    expect(pinned).toBeCloseTo(plain * RECALL.pinnedBoost, 12);
    expect(locked).toBeCloseTo(plain * RECALL.lockedBoost, 12);
  });

  it("recalls_30d_unused = 20 gives hub ≈ 1/(1 + 0.15 × ln 21)", () => {
    const out = applyWeights([candidate({ recalls_30d_unused: 20 })], NOW);
    const hub = 1 / (1 + 0.15 * Math.log(21));
    expect(out[0]?.weighted).toBeCloseTo(0.01 * hub, 12);
    expect(hub).toBeCloseTo(0.6865, 3);
  });

  it("returns a new array sorted by weighted desc, ties by id", () => {
    const items = [candidate({ id: "b" }), candidate({ id: "a" }), candidate({ id: "c", fused: 0.02 })];
    const out = applyWeights(items, NOW);
    expect(out.map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(items[0]?.id).toBe("b"); // input not mutated
  });
});

describe("RECALL", () => {
  it("is frozen — assigning to a field throws in strict mode", () => {
    expect(() => {
      (RECALL as { sectionBoost: number }).sectionBoost = 2;
    }).toThrow();
    expect(() => {
      (RECALL.scope as { S0: number }).S0 = 9;
    }).toThrow();
  });

  it("has the spec values", () => {
    expect(RECALL.scope).toEqual({ S0: 1.3, S1: 1.1, S2: 1.2, S3: 1.0, S4: 1.0 });
    expect(RECALL.rrfK).toBe(60);
    expect(RECALL.rerankBlend).toBe(0.6);
    expect(RECALL.charBudget).toBe(6000);
    expect(RECALL.rerankTop).toBe(50);
  });
});
