import { describe, expect, it } from "vitest";
import { finalize } from "../src/finalize.js";
import type { Scored } from "../src/types.js";

let n = 0;
function item(overrides?: Partial<Scored>): Scored {
  n += 1;
  return {
    id: `item-${n}`,
    type: "fact",
    text: `text ${n}`,
    project_id: "p1",
    cites: [],
    created_at: "2026-09-19T00:00:00Z",
    is_pinned: false,
    locked: false,
    recalls_30d_unused: 0,
    ranks: { vector: 1 },
    scope: "S3",
    fused: 0.01,
    weighted: 0.01,
    score: 0.01,
    ...overrides,
  };
}

function section(page_id: string, overrides?: Partial<Scored>): Scored {
  return item({ type: "section", page_id, ...overrides });
}

describe("finalize", () => {
  it("3 sections of one page in → 2 out", () => {
    const ranked = [section("pg"), section("pg"), section("pg")];
    expect(finalize(ranked, 8)).toHaveLength(2);
  });

  it("4 facts of one session in → 3 out; facts without a session are unlimited", () => {
    const sid = "s1";
    const withSession = [
      item({ session_id: sid }),
      item({ session_id: sid }),
      item({ session_id: sid }),
      item({ session_id: sid }),
    ];
    expect(finalize(withSession, 8)).toHaveLength(3);

    const noSession = Array.from({ length: 5 }, () => item({}));
    expect(finalize(noSession, 8)).toHaveLength(5);
  });

  it("a fact cited by a kept section is dropped; kept when that section was dropped by the page cap", () => {
    const f1 = item({ id: "fact-1" });
    const citing = section("pg", { cites: ["fact-1"] });
    expect(finalize([citing, f1], 8).map((i) => i.id)).toEqual([citing.id]);

    // Two sections of the page already kept → the citing section is dropped,
    // so its citation is not registered and the fact survives.
    const pg1 = section("pg2", { cites: [] });
    const pg2 = section("pg2", { cites: [] });
    const dropped = section("pg2", { cites: ["fact-2"] });
    const f2 = item({ id: "fact-2" });
    expect(finalize([pg1, pg2, dropped, f2], 8).map((i) => i.id)).toContain("fact-2");
    expect(f1.id).toBe("fact-1");
  });

  it("a 5,900-char item then 200 then 50 → first and third kept", () => {
    const big = item({ text: "x".repeat(5900) });
    const mid = item({ text: "y".repeat(200) });
    const small = item({ text: "z".repeat(50) });
    const out = finalize([big, mid, small], 8);
    expect(out.map((i) => i.text.length)).toEqual([5900, 50]);
  });

  it("k clamps to 1..20", () => {
    const ranked = Array.from({ length: 25 }, () => item({}));
    expect(finalize(ranked, 0)).toHaveLength(1);
    expect(finalize(ranked, 99)).toHaveLength(20);
  });

  it("sections come before facts even when a fact ranked first", () => {
    const ranked = [item({}), section("pg"), item({})];
    const out = finalize(ranked, 8);
    expect(out[0]!.type).toBe("section");
    expect(out.map((i) => i.type)).toEqual(["section", "fact", "fact"]);
  });

  it("does not mutate the input", () => {
    const ranked = [item({}), section("pg")];
    const copy = [...ranked];
    finalize(ranked, 8);
    expect(ranked).toEqual(copy);
  });
});
