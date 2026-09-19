import {
  checkAgentSection,
  citedIds,
  confirmedConfidence,
  deterministicAppend,
  extractedConfidence,
  guardSupersede,
  mapKind,
  pageSlug,
  pageSummary,
  pageTitleOk,
  quoteFound,
  slugTag,
  stripCitations,
  unmapKind,
  withoutBlocksCiting,
} from "../../apps/server/src/modules/jobs/rules/living-rules";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

describe("living rules (server re-validation of a worker's result)", () => {
  describe("quote gate", () => {
    const turns = ["We decided to ship on Friday.", "Assistant: noted — “per store”, not per seat."];
    it("finds a verbatim quote after normalising whitespace and quote marks, and says which turn", () => {
      expect(quoteFound("decided  to ship\non Friday", turns)).toEqual({ found: true, turnIndex: 0 });
      expect(quoteFound('"per store", not per seat', turns)).toEqual({ found: true, turnIndex: 1 });
    });
    it("refuses a quote that is not in the session", () => {
      expect(quoteFound("we will ship on Monday", turns)).toEqual({ found: false, turnIndex: -1 });
    });
    it("a quote of exactly 8 characters counts; 7 does not", () => {
      expect(quoteFound("decided ", turns).found).toBe(false); // trims to 7
      expect(quoteFound("We decid", turns)).toEqual({ found: true, turnIndex: 0 });
      expect(quoteFound("We deci", turns).found).toBe(false);
    });
  });

  describe("kinds and confidence (Spec 02 §7, §8)", () => {
    it("maps every product kind and back", () => {
      for (const kind of ["decision", "fact", "how-to", "issue", "question", "action", "idea"] as const) {
        const { dbKind, extraTags } = mapKind(kind);
        expect(unmapKind(dbKind, extraTags)).toBe(kind);
      }
    });
    it("user 0.75, assistant 0.55, unknown 0.50; a confirmation adds 0.10 up to 0.95", () => {
      expect([extractedConfidence("user"), extractedConfidence("assistant"), extractedConfidence(null)]).toEqual([0.75, 0.55, 0.5]);
      expect(confirmedConfidence(0.75)).toBe(0.85);
      expect(confirmedConfidence(0.85)).toBe(0.95);
      expect(confirmedConfidence(0.9)).toBe(0.95);
    });
  });

  describe("supersede guards (Spec 02 §3)", () => {
    const fact = { kind: "decision" as const, created_at: "2026-06-01T00:00:00Z", project_id: "p1", owner_user_id: "u1" };
    const cand = (id: string, over: Partial<{ created_at: string; project_id: string; owner_user_id: string; is_pinned: boolean }> = {}) => ({
      id,
      project_id: "p1",
      created_at: "2026-05-01T00:00:00Z",
      owner_user_id: "u1",
      is_pinned: false,
      ...over,
    });
    it("rejects unknown, newer, other-space and unparseable targets with a reason", () => {
      const out = guardSupersede(fact, ["x", "n", "o", "d"], [
        cand("n", { created_at: "2026-05-31T23:30:00-05:00" }),
        cand("o", { project_id: "p2" }),
        cand("d", { created_at: "never" }),
      ]);
      expect(out).toEqual({
        supersedes: [],
        rejected: [
          { id: "x", reason: "unknown_id" },
          { id: "n", reason: "not_older" },
          { id: "o", reason: "other_project" },
          { id: "d", reason: "bad_date" },
        ],
      });
    });
    it("a question may not supersede another author's fact; a decision may", () => {
      expect(guardSupersede({ ...fact, kind: "question" }, ["a"], [cand("a", { owner_user_id: "u2" })]).rejected).toEqual([{ id: "a", reason: "protected_target" }]);
      expect(guardSupersede(fact, ["a"], [cand("a", { owner_user_id: "u2" })]).supersedes).toEqual(["a"]);
    });
    it("three valid supersessions pass; four are all ignored as suspicious", () => {
      expect(guardSupersede(fact, ["a", "b", "c", "a"], ["a", "b", "c"].map((id) => cand(id))).supersedes).toEqual(["a", "b", "c"]);
      const four = guardSupersede(fact, ["a", "b", "c", "d"], ["a", "b", "c", "d"].map((id) => cand(id)));
      expect(four.supersedes).toEqual([]);
      expect(four.rejected.map((r) => r.reason)).toEqual(["suspicious_supersede", "suspicious_supersede", "suspicious_supersede", "suspicious_supersede"]);
    });
  });

  describe("sections (Spec 02 §6)", () => {
    const citable = new Set([A, B]);
    it("accepts a body where every prose block cites a fact of the space", () => {
      expect(checkAgentSection(`Ships Friday [^f:${A}].\n\n- Per store [^f:${B}].`, citable)).toEqual({ ok: true });
    });
    it("refuses an uncited sentence, a citation from elsewhere, and a body over 1,200 characters", () => {
      expect(checkAgentSection(`Ships Friday [^f:${A}].\n\nA person wrote this.`, citable)).toEqual({ ok: false, reason: "uncited_sentence" });
      expect(checkAgentSection(`Ships Friday [^f:${C}].`, citable)).toEqual({ ok: false, reason: "citation_not_in_space" });
      const cite = ` [^f:${A}].`;
      const at = "x".repeat(1200 - cite.length) + cite;
      expect(at.length).toBe(1200);
      expect(checkAgentSection(at, citable)).toEqual({ ok: true });
      expect(checkAgentSection(`y${at}`, citable)).toEqual({ ok: false, reason: "too_long" });
    });
    it("drops every block resting on a refused fact and keeps the rest as written", () => {
      const body = `Ships Friday [^f:${A}].\n\n- Per store [^f:${B}].\n- Recorded on video [^f:${C}].`;
      expect(withoutBlocksCiting(body, new Set([C]))).toBe(`Ships Friday [^f:${A}].\n\n- Per store [^f:${B}].`);
      expect(withoutBlocksCiting(body, new Set())).toBe(body);
    });
    it("the fallback is one bullet per fact after what is there", () => {
      expect(deterministicAppend("", [{ id: A, statement: "Line one\nline two." }])).toBe(`- Line one line two. [^f:${A}]`);
      expect(deterministicAppend(`Ships Friday [^f:${B}].`, [{ id: A, statement: "Per store." }])).toBe(`Ships Friday [^f:${B}].\n\n- Per store. [^f:${A}]`);
    });
    it("reads citations, strips them for summaries, and cuts the summary at 240 characters", () => {
      expect(citedIds(`a [^f:${A.toUpperCase()}] b [^f:${A}] [^f:${B}]`)).toEqual([A, B]);
      expect(stripCitations(`Ships Friday [^f:${A}].`)).toBe("Ships Friday.");
      expect(pageSummary("x".repeat(240))).toBe("x".repeat(240));
      expect(pageSummary("x".repeat(241))).toBe(`${"x".repeat(239)}…`);
      expect(pageSummary(`- One [^f:${A}].\n- Two [^f:${B}].`)).toBe("One. Two.");
    });
  });

  describe("page titles, slugs and tags", () => {
    it("a title is at most 60 characters and never a sentence", () => {
      expect(pageTitleOk(`N — ${"p".repeat(56)}`)).toBe(true);
      expect(pageTitleOk(`N — ${"p".repeat(57)}`)).toBe(false);
      expect(pageTitleOk("We decided to ship.")).toBe(false);
      expect(pageTitleOk("  ")).toBe(false);
    });
    it("slugs and tags keep any script; Latin accents fold; kinds are not tags", () => {
      expect(pageSlug("Northgate — Pricing")).toBe("northgate-pricing");
      expect(slugTag("Décision Log")).toBe("decision-log");
      expect(slugTag("ราคา")).toBe("ราคา");
      expect(slugTag("idea")).toBeNull();
      expect(slugTag("a".repeat(31) + "-" + "b".repeat(18))).toBe("a".repeat(31));
    });
  });
});
