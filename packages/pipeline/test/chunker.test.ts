import { describe, expect, it } from "vitest";
import { chunkTurns, shouldExtract } from "../src/chunker.js";
import type { Turn } from "../src/types.js";

function turn(seq: number, content: string, role: Turn["role"] = "user"): Turn {
  return { seq, role, content };
}

describe("chunkTurns", () => {
  it("10 turns of 1,000 chars make 2 chunks of 6 + 4 with 2 overlap turns", () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1, "a".repeat(1000)));
    const chunks = chunkTurns(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.turns).toHaveLength(6);
    expect(chunks[1]!.turns).toHaveLength(4);
    expect(chunks[1]!.overlap).toHaveLength(2);
    expect(chunks[1]!.overlap[0]?.seq).toBe(5);
    expect(chunks[1]!.text).toContain("[context — already processed]");
    expect(chunks[1]!.text).toContain("[new]");
  });

  it("one 15,000-char turn becomes 3 parts, none over 6,000, concatenation preserved", () => {
    const content = ("w".repeat(498) + ". ").repeat(30);
    expect(content.length).toBe(15000);
    const chunks = chunkTurns([turn(1, content)]);
    const parts = chunks.flatMap((c) => c.turns);
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.content.length).toBeLessThanOrEqual(6000);
    expect(parts.map((p) => p.content).join("")).toBe(content);
    expect(parts.every((p, i) => p.seq === 1 && p.part === i + 1)).toBe(true);
  });

  it("system turns never appear", () => {
    const chunks = chunkTurns([
      turn(1, "hello", "system"),
      turn(2, "real content that is long enough to be kept"),
    ]);
    for (const c of chunks) {
      expect(c.turns.some((t) => t.role === "system")).toBe(false);
      expect(c.text).not.toContain("system:");
    }
  });

  it("a 60-line fenced ts block becomes a marker; a 10-line block is untouched", () => {
    const long = turn(1, "before\n```ts\n" + Array.from({ length: 60 }, (_, i) => `x${i};`).join("\n") + "\n```\nafter");
    const c = chunkTurns([long])[0]!;
    expect(c.turns[0]?.content).toContain("[code omitted: 60 lines, ts]");
    expect(c.turns[0]?.content).not.toContain("x0;");

    const short = turn(1, "```ts\n" + Array.from({ length: 10 }, (_, i) => `x${i};`).join("\n") + "\n```");
    expect(chunkTurns([short])[0]!.turns[0]!.content).toContain("x0;");
  });

  it("a fence without a language is marked as text", () => {
    const long = turn(1, "```\n" + Array.from({ length: 45 }, (_, i) => `x${i};`).join("\n") + "\n```");
    expect(chunkTurns([long])[0]!.turns[0]!.content).toContain("[code omitted: 45 lines, text]");
  });

  it("shouldExtract is false at 199 chars and true at 200", () => {
    expect(shouldExtract([turn(1, "u".repeat(199))])).toBe(false);
    expect(shouldExtract([turn(1, "u".repeat(200))])).toBe(true);
  });

  it("empty input gives no chunks", () => {
    expect(chunkTurns([])).toEqual([]);
  });
});
