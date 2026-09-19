import { describe, expect, it } from "vitest";
import { normalise, quoteGate } from "../src/quote-gate.js";
import type { ExtractedFact, Turn } from "../src/types.js";

const fact = (quote: string, statement = "Supported fact"): ExtractedFact => ({
  statement,
  quote,
  kind: "fact",
});
const turn = (seq: number, content: string): Turn => ({ seq, role: "user", content });
const gate = (facts: ExtractedFact[], turns: Turn[], overlap: Turn[] = []) =>
  quoteGate(facts, { turns, overlap });

describe("normalise", () => {
  it("matches the agents normaliser rules and lowercases", () => {
    expect(normalise("  “A\u200B  quote”—here…  ")).toBe('"a quote"-here...');
  });
});

describe("quoteGate", () => {
  it("keeps a quote differing only by curly quotes, case, and double spaces", () => {
    const input = fact('She said "HELLO  WORLD" today.');
    expect(gate([input], [turn(7, "She said “hello world” today.")])).toEqual({
      kept: [{ ...input, turn_seq: 7 }],
      dropped: [],
    });
  });

  it("does not match a quote across two turns", () => {
    expect(gate([fact("alpha beta gamma")], [turn(1, "alpha beta"), turn(2, "gamma")]).dropped)
      .toEqual([{ index: 0, reason: "quote_not_found" }]);
  });

  it("reports a quote found only in overlap", () => {
    expect(gate([fact("overlap quote here")], [], [turn(3, "overlap quote here")]).dropped)
      .toEqual([{ index: 0, reason: "quote_only_in_overlap" }]);
  });

  it("rejects 11 normalised characters and permits 12", () => {
    const result = gate([fact("12345678901"), fact("123456789012")], [turn(4, "123456789012")]);
    expect(result.dropped).toEqual([{ index: 0, reason: "quote_too_short" }]);
    expect(result.kept).toEqual([{ ...fact("123456789012"), turn_seq: 4 }]);
  });

  it("checks secrets before quote length and search", () => {
    const secret = "AKIA1234567890ABCDEF";
    expect(gate([fact("missing", secret)], []).dropped)
      .toEqual([{ index: 0, reason: "secret" }]);
  });

  it.each([
    ["Thai", "นี่คือข้อความภาษาไทย"],
    ["Hindi", "यह एक हिंदी उद्धरण है"],
  ])("keeps a verbatim %s quote", (_language, quote) => {
    expect(gate([fact(quote)], [turn(9, `Prefix ${quote} suffix`)]).kept)
      .toEqual([{ ...fact(quote), turn_seq: 9 }]);
  });

  it("keeps a main-turn hit even when overlap also contains the quote", () => {
    const input = fact("same quote in both");
    expect(gate([input], [turn(8, input.quote)], [turn(2, input.quote)]).kept)
      .toEqual([{ ...input, turn_seq: 8 }]);
  });

  it("preserves original fact indexes in dropped results", () => {
    expect(gate([fact("too short"), fact("another absent quote")], []).dropped).toEqual([
      { index: 0, reason: "quote_too_short" },
      { index: 1, reason: "quote_not_found" },
    ]);
  });
});
