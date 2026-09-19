import { describe, expect, it } from "vitest";
import { decideDuplicate, guardSupersede } from "../src/dedupe.js";
import type { Kind, Neighbour } from "../src/types.js";

function neighbour(id: string, similarity: number, overrides?: Partial<Neighbour>): Neighbour {
  return {
    id,
    project_id: "p1",
    statement: `statement of ${id}`,
    kind: "fact",
    created_at: "2026-01-01T00:00:00Z",
    owner_user_id: "user-a",
    is_pinned: false,
    confidence: 0.5,
    similarity,
    ...overrides,
  };
}

describe("decideDuplicate", () => {
  it("0.97 → duplicate; 0.9699 → ask_agent; 0.82 → ask_agent; 0.8199 → new; none → new", () => {
    expect(decideDuplicate([neighbour("n1", 0.97)])).toEqual({ action: "duplicate", of: "n1" });
    expect(decideDuplicate([neighbour("n1", 0.9699)]).action).toBe("ask_agent");
    expect(decideDuplicate([neighbour("n1", 0.82)]).action).toBe("ask_agent");
    expect(decideDuplicate([neighbour("n1", 0.8199)])).toEqual({ action: "new" });
    expect(decideDuplicate([])).toEqual({ action: "new" });
  });

  it("ask_agent candidates are ≥ 0.82, best first, max 10", () => {
    const neighbours = [
      neighbour("n1", 0.9),
      neighbour("n2", 0.95),
      neighbour("n3", 0.82),
      neighbour("n4", 0.81),
      ...Array.from({ length: 12 }, (_, i) => neighbour(`x${i}`, 0.83 + i * 0.001)),
    ];
    const out = decideDuplicate(neighbours);
    if (out.action !== "ask_agent") throw new Error("expected ask_agent");
    expect(out.candidates.length).toBeLessThanOrEqual(10);
    expect(out.candidates.every((c) => c.similarity >= 0.82)).toBe(true);
    expect(out.candidates[0]?.id).toBe("n2");
  });

  it("ignores neighbours from another project than the first neighbour's", () => {
    const out = decideDuplicate([
      neighbour("n1", 0.5),
      neighbour("n2", 0.99, { project_id: "p2" }),
    ]);
    expect(out).toEqual({ action: "new" });
  });
});

describe("guardSupersede", () => {
  const newFact = {
    kind: "idea" as Kind,
    created_at: "2026-06-01T00:00:00Z",
    project_id: "p1",
    owner_user_id: "user-a",
  };

  it("unknown id → reason unknown_id", () => {
    const out = guardSupersede(newFact, { duplicate_of: null, supersedes: ["ghost"] }, [
      neighbour("n1", 0.9),
    ]);
    expect(out.rejected).toEqual([{ id: "ghost", reason: "unknown_id" }]);
    expect(out.supersedes).toEqual([]);
  });

  it("a fact not older than the new one → reason not_older", () => {
    const out = guardSupersede(newFact, { duplicate_of: null, supersedes: ["n1"] }, [
      neighbour("n1", 0.9, { created_at: "2026-12-01T00:00:00Z" }),
    ]);
    expect(out.rejected).toEqual([{ id: "n1", reason: "not_older" }]);
  });

  it("another project → reason other_project", () => {
    const out = guardSupersede(newFact, { duplicate_of: null, supersedes: ["n1"] }, [
      neighbour("n1", 0.9, { project_id: "p2" }),
    ]);
    expect(out.rejected).toEqual([{ id: "n1", reason: "other_project" }]);
  });

  it("a pinned or other-author target needs decision/fact/how-to → reason protected_target", () => {
    const pinned = guardSupersede(newFact, { duplicate_of: null, supersedes: ["n1"] }, [
      neighbour("n1", 0.9, { is_pinned: true }),
    ]);
    expect(pinned.rejected).toEqual([{ id: "n1", reason: "protected_target" }]);

    const otherAuthor = guardSupersede(newFact, { duplicate_of: null, supersedes: ["n1"] }, [
      neighbour("n1", 0.9, { owner_user_id: "user-b" }),
    ]);
    expect(otherAuthor.rejected).toEqual([{ id: "n1", reason: "protected_target" }]);
  });

  it("a question cannot supersede another author's fact; a decision can", () => {
    const candidates = [neighbour("n1", 0.9, { owner_user_id: "user-b" })];
    const question = guardSupersede(
      { ...newFact, kind: "question" },
      { duplicate_of: null, supersedes: ["n1"] },
      candidates,
    );
    expect(question.supersedes).toEqual([]);

    const decision = guardSupersede(
      { ...newFact, kind: "decision" },
      { duplicate_of: null, supersedes: ["n1"] },
      candidates,
    );
    expect(decision.supersedes).toEqual(["n1"]);
    expect(decision.rejected).toEqual([]);
  });

  it("4 supersedes → all rejected as suspicious_supersede", () => {
    const candidates = ["a", "b", "c", "d"].map((id) => neighbour(id, 0.9));
    const out = guardSupersede(newFact, { duplicate_of: null, supersedes: ["a", "b", "c", "d"] }, candidates);
    expect(out.supersedes).toEqual([]);
    expect(out.rejected).toEqual([
      { id: "a", reason: "suspicious_supersede" },
      { id: "b", reason: "suspicious_supersede" },
      { id: "c", reason: "suspicious_supersede" },
      { id: "d", reason: "suspicious_supersede" },
    ]);
  });

  it("a valid duplicate_of forces supersedes empty", () => {
    const candidates = [neighbour("n1", 0.98), neighbour("n2", 0.9)];
    const out = guardSupersede(newFact, { duplicate_of: "n1", supersedes: ["n2"] }, candidates);
    expect(out).toEqual({ duplicate_of: "n1", supersedes: [], rejected: [] });
  });

  it("an unknown duplicate_of is ignored", () => {
    const out = guardSupersede(newFact, { duplicate_of: "ghost", supersedes: [] }, [
      neighbour("n1", 0.98),
    ]);
    expect(out.duplicate_of).toBeNull();
  });
});
