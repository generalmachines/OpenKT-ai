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
  it("matches the agents normaliser rules", () => {
    expect(normalise("  “A\u200B  quote”—here…  ")).toBe('"A quote"-here...');
  });
});

describe("quoteGate", () => {
  it("keeps a quote differing only by curly quotes, double spaces, zero-width, em dash, and ellipsis", () => {
    const input = fact('She said "hello  world" - today...');
    expect(gate([input], [turn(7, "She said “hello\u200B world” — today…")])).toEqual({
      kept: [{ ...input, turn_seq: 7 }],
      dropped: [],
    });
  });

  it("matches case-sensitively", () => {
    expect(gate([fact("Northgate Runs 14 Stores")], [turn(1, "northgate runs 14 stores today")]).dropped)
      .toEqual([{ index: 0, reason: "quote_not_found" }]);
  });

  it("does not match a quote across two turns", () => {
    expect(gate([fact("alpha beta gamma")], [turn(1, "alpha beta"), turn(2, "gamma")]).dropped)
      .toEqual([{ index: 0, reason: "quote_not_found" }]);
  });

  it("reports a quote found only in overlap", () => {
    expect(gate([fact("overlap quote here")], [], [turn(3, "overlap quote here")]).dropped)
      .toEqual([{ index: 0, reason: "quote_only_in_overlap" }]);
  });

  it("rejects 7 normalised characters and permits 8", () => {
    const result = gate([fact("1234567"), fact("12345678")], [turn(4, "12345678")]);
    expect(result.dropped).toEqual([{ index: 0, reason: "quote_too_short" }]);
    expect(result.kept).toEqual([{ ...fact("12345678"), turn_seq: 4 }]);
  });

  it("checks secrets before quote length and search", () => {
    const secret = "AKIA1234567890ABCDEF";
    expect(gate([fact("missing", secret)], []).dropped)
      .toEqual([{ index: 0, reason: "secret" }]);
  });

  it("rejects a secret in the quote", () => {
    const secret = "AKIA1234567890ABCDEF";
    expect(gate([fact(secret)], [turn(1, secret)]).dropped)
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
    expect(gate([fact("short!!"), fact("another absent quote")], []).dropped).toEqual([
      { index: 0, reason: "quote_too_short" },
      { index: 1, reason: "quote_not_found" },
    ]);
  });
});
