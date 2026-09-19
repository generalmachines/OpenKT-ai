import { describe, expect, it } from "vitest";
import { fallbackAppend, parseCitations, validateSection } from "../src/section.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

describe("parseCitations", () => {
  it("returns uuids in order of appearance, lowercased", () => {
    const md = `First [^f:${A}] then [^f:${B.toUpperCase()}] and [^f:${A}] again.`;
    expect(parseCitations(md)).toEqual([A, B, A]);
  });
});

describe("validateSection", () => {
  it("a valid two-sentence section with both facts cited is ok", () => {
    const md = `Northgate runs 14 stores [^f:${A}]. Three are on a legacy POS [^f:${B}].`;
    expect(validateSection(md, { inputFactIds: [A, B], existingFactIds: [] })).toEqual({ ok: true });
  });

  it("too_long", () => {
    const md = `Long text [^f:${A}] ${"x".repeat(1300)}`;
    const out = validateSection(md, { inputFactIds: [A], existingFactIds: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors).toContain("too_long");
  });

  it("uncited_sentence", () => {
    const md = `Point one [^f:${A}]. A sentence without any citation.`;
    const out = validateSection(md, { inputFactIds: [A], existingFactIds: [] });
    if (!out.ok) expect(out.errors).toContain("uncited_sentence");
    expect(out.ok).toBe(false);
  });

  it("missing_fact", () => {
    const out = validateSection(`Only one is cited [^f:${A}].`, {
      inputFactIds: [A, B],
      existingFactIds: [],
    });
    expect(out).toEqual({ ok: false, errors: [`missing_fact:${B}`] });
  });

  it("unknown_citation", () => {
    const out = validateSection(`Something [^f:${C}].`, {
      inputFactIds: [A],
      existingFactIds: [],
    });
    expect(out).toEqual({
      ok: false,
      errors: [`missing_fact:${A}`, `unknown_citation:${C}`],
    });
  });

  it("a citation already in the section counts as known", () => {
    const out = validateSection(`Old [^f:${A}] with new [^f:${C}] [^f:${A}].`, {
      inputFactIds: [C],
      existingFactIds: [A],
    });
    expect(out).toEqual({ ok: true });
  });

  it("collects two errors at once", () => {
    const out = validateSection(`No citations here at all.`, {
      inputFactIds: [A],
      existingFactIds: [],
    });
    expect(out).toEqual({ ok: false, errors: ["uncited_sentence", `missing_fact:${A}`] });
  });

  it("headings and empty lines are not sentences; bullets count", () => {
    const md = `## Heading without citation\n\n- bullet with [^f:${A}]`;
    expect(validateSection(md, { inputFactIds: [A], existingFactIds: [] })).toEqual({ ok: true });
  });

  it("uppercase uuids are compared case-insensitively", () => {
    const md = `Uppercase citation [^f:${B.toUpperCase()}].`;
    expect(validateSection(md, { inputFactIds: [B], existingFactIds: [] })).toEqual({ ok: true });
  });
});

describe("fallbackAppend", () => {
  it("appends one bullet per fact with the citation and no trailing period", () => {
    const out = fallbackAppend("Existing text.", [
      { id: A, statement: "Northgate runs 14 stores." },
      { id: B, statement: "Three are legacy. " },
    ]);
    expect(out).toBe(
      `Existing text.\n- Northgate runs 14 stores [^f:${A}]\n- Three are legacy [^f:${B}]`,
    );
  });

  it("output passes validateSection when under the length limit", () => {
    const md = fallbackAppend("", [
      { id: A, statement: "Fact one here." },
      { id: B, statement: "Fact two here." },
    ]);
    expect(validateSection(md, { inputFactIds: [A, B], existingFactIds: [] })).toEqual({ ok: true });
  });
});
