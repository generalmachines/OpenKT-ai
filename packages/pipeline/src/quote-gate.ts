import { hasSecret } from "./secrets.js";
import type { ExtractedFact, Turn } from "./types.js";

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Normalisation shared conceptually with packages/agents/src/text.ts. */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[\u2018\u2019\u201A\u201B\u2032`\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

export const MIN_QUOTE_CHARS = 8;

type KeptFact = ExtractedFact & { turn_seq: number };
type DropReason = "quote_not_found" | "quote_only_in_overlap" | "quote_too_short" | "secret";

export function quoteGate(
  facts: ExtractedFact[],
  chunk: { turns: Turn[]; overlap: Turn[] },
): { kept: KeptFact[]; dropped: { index: number; reason: DropReason }[] } {
  const kept: KeptFact[] = [];
  const dropped: { index: number; reason: DropReason }[] = [];
  const turns = chunk.turns.map((turn) => ({ seq: turn.seq, content: normalise(turn.content) }));
  const overlap = chunk.overlap.map((turn) => normalise(turn.content));

  facts.forEach((fact, index) => {
    if (hasSecret(fact.statement) || hasSecret(fact.quote)) {
      dropped.push({ index, reason: "secret" });
      return;
    }

    const quote = normalise(fact.quote);
    if (quote.length < MIN_QUOTE_CHARS) {
      dropped.push({ index, reason: "quote_too_short" });
      return;
    }

    const turn = turns.find((candidate) => candidate.content.includes(quote));
    if (turn) {
      kept.push({ ...fact, turn_seq: turn.seq });
      return;
    }

    dropped.push({
      index,
      reason: overlap.some((content) => content.includes(quote))
        ? "quote_only_in_overlap"
        : "quote_not_found",
    });
  });

  return { kept, dropped };
}
