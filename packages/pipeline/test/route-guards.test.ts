import { describe, expect, it } from "vitest";
import { guardRoutes } from "../src/route-guards.js";
import type { Kind } from "../src/types.js";

function fact(id: string, overrides?: { confidence?: number; kind?: Kind; age_days?: number }) {
  return {
    id,
    project_id: "p1",
    statement: `statement ${id}`,
    kind: overrides?.kind ?? ("fact" as Kind),
    created_at: "2026-01-01T00:00:00Z",
    owner_user_id: "user-a",
    is_pinned: false,
    confidence: overrides?.confidence ?? 0.8,
    age_days: overrides?.age_days ?? 1,
  };
}

const pages = [
  {
    id: "page-1",
    sections: [
      { heading: "Overview", locked: false },
      { heading: "Pricing", locked: true },
    ],
  },
];

function run(proposals: Parameters<typeof guardRoutes>[0]["proposals"], facts = [fact("f1"), fact("f2", { kind: "decision" }), fact("f3"), fact("f4")]) {
  return guardRoutes({
    facts,
    proposals,
    pages,
    unroutedTitles: [],
    titleSimilarity: (a, b) => (a.toLowerCase() === b.toLowerCase() ? 1 : 0),
  });
}

describe("guardRoutes", () => {
  it("unknown fact_id is ignored", () => {
    const out = run([{ fact_id: "ghost", action: "noop" }]);
    expect(out).toEqual({ routes: [], unrouted: [] });
  });

  it("confidence < 0.4 → low_confidence", () => {
    const out = run([{ fact_id: "f1", action: "append", page_id: "page-1", section_heading: "Overview" }], [fact("f1", { confidence: 0.39 })]);
    expect(out.unrouted).toEqual([{ fact_id: "f1", reason: "low_confidence" }]);
  });

  it("action or question older than 30 days → stale", () => {
    const out = run([{ fact_id: "f1", action: "append", page_id: "page-1", section_heading: "Overview" }], [fact("f1", { kind: "action", age_days: 31 })]);
    expect(out.unrouted).toEqual([{ fact_id: "f1", reason: "stale" }]);
    const ok = run([{ fact_id: "f1", action: "append", page_id: "page-1", section_heading: "Overview" }], [fact("f1", { kind: "question", age_days: 30 })]);
    expect(ok.unrouted).toEqual([]);
  });

  it("unknown page_id → unknown_page", () => {
    const out = run([{ fact_id: "f1", action: "append", page_id: "nope", section_heading: "Overview" }]);
    expect(out.unrouted).toEqual([{ fact_id: "f1", reason: "unknown_page" }]);
  });

  it("an unknown section on a known page becomes append with that heading", () => {
    const out = run([{ fact_id: "f1", action: "rewrite_section", page_id: "page-1", section_heading: "Fresh" }]);
    expect(out.routes).toEqual([
      { fact_id: "f1", action: "append", page_id: "page-1", section_heading: "Fresh" },
    ]);
  });

  it("a locked target becomes append on Updates with the flag set", () => {
    const out = run([{ fact_id: "f1", action: "rewrite_section", page_id: "page-1", section_heading: "Pricing" }]);
    expect(out.routes).toEqual([
      { fact_id: "f1", action: "append", page_id: "page-1", section_heading: "Updates", redirected_from_locked: true },
    ]);
  });

  it("bad titles → bad_title", () => {
    const long = "x".repeat(61) + " — y";
    for (const title of [long, "no em dash here", "Sentence title."]) {
      const out = run([{ fact_id: "f1", action: "new_page", new_page_title: title }]);
      expect(out.unrouted).toEqual([{ fact_id: "f1", reason: "bad_title" }]);
    }
  });

  it("two similar new_page proposals end up on one page", () => {
    const out = run([
      { fact_id: "f1", action: "new_page", new_page_title: "Northgate — pricing" },
      { fact_id: "f2", action: "new_page", new_page_title: "Northgate — Pricing" },
    ]);
    expect(out.routes).toHaveLength(2);
    expect(out.routes.every((r) => r.new_page_title === "Northgate — pricing")).toBe(true);
  });

  it("a single fact-kind proposal waits for more; a decision is routed", () => {
    const waiting = run([{ fact_id: "f1", action: "new_page", new_page_title: "Northgate — pricing" }], [fact("f1")]);
    expect(waiting.unrouted).toEqual([{ fact_id: "f1", reason: "waiting_for_more" }]);

    const routed = run([{ fact_id: "f2", action: "new_page", new_page_title: "Northgate — pricing" }], [fact("f2", { kind: "decision" })]);
    expect(routed.routes).toEqual([
      { fact_id: "f2", action: "new_page", new_page_title: "Northgate — pricing" },
    ]);
  });

  it("unrouted titles count toward the 3-fact minimum", () => {
    const out = guardRoutes({
      facts: [fact("f1")],
      proposals: [{ fact_id: "f1", action: "new_page", new_page_title: "Northgate — pricing" }],
      pages,
      unroutedTitles: ["Northgate — pricing", "northgate — pricing"],
      titleSimilarity: (a, b) => (a.toLowerCase() === b.toLowerCase() ? 1 : 0),
    });
    expect(out.routes).toHaveLength(1);
    expect(out.unrouted).toEqual([]);
  });
});
