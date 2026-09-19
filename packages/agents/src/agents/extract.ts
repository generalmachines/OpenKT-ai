// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { statesSecret } from "../secrets.js";
import { chunkText, fence, normaliseForMatch, renderChunk, renderMeta } from "../text.js";
import type { Kind, SessionChunk, SessionMeta } from "../types.js";

export interface ExtractInput {
  chunk: SessionChunk;
  session: SessionMeta;
  /**
   * The tail of the previous chunk, shown as "[context — already processed]" so names and references
   * resolve. Never quotable: the quote gate searches `chunk` only.
   */
  overlap?: SessionChunk;
}
export interface ExtractedFact {
  statement: string;
  /** Verbatim substring of the chunk. */
  quote: string;
  kind: Kind;
}
export interface ExtractOutput {
  facts: ExtractedFact[];
}

/** Shorter quotes match almost anything and prove nothing. */
export const MIN_QUOTE_CHARS = 8;

/**
 * THE QUOTE GATE. Keeps a fact only if its quote occurs in the session text after whitespace and
 * quote-mark normalisation. Exported because the server re-runs it on facts extracted elsewhere.
 */
export function quoteGate<F extends { quote: string }>(facts: F[], sessionText: string): { kept: F[]; dropped: F[] } {
  const haystack = normaliseForMatch(sessionText);
  const kept: F[] = [];
  const dropped: F[] = [];
  for (const fact of facts) {
    const needle = normaliseForMatch(fact.quote);
    (needle.length >= MIN_QUOTE_CHARS && haystack.includes(needle) ? kept : dropped).push(fact);
  }
  return { kept, dropped };
}

/** Spec 02 §2: at most 12 facts per chunk; beyond that the higher-priority kinds stay. */
export const MAX_FACTS_PER_CHUNK = 12;
export const KIND_PRIORITY: readonly Kind[] = ["decision", "issue", "how-to", "action", "question", "fact", "idea"];

const CONTEXT_OPEN = "[context — already processed]";
const CONTEXT_CLOSE = "[end of context]";

function renderSession(input: ExtractInput): string {
  const overlap = input.overlap && chunkText(input.overlap).trim() ? input.overlap : undefined;
  if (!overlap) return renderChunk(input.chunk);
  const offset = typeof overlap === "string" ? 0 : overlap.length;
  return `${CONTEXT_OPEN}\n${renderChunk(overlap)}\n${CONTEXT_CLOSE}\n${renderChunk(input.chunk, offset)}`;
}

export const extract = defineAgent<ExtractInput, ExtractOutput>({
  name: "extract",
  prompt: PROMPTS.extract,
  schema: SCHEMAS.extract,
  maxTokens: 3000,
  shortCircuit: (input) => (chunkText(input.chunk).trim() ? undefined : { facts: [] }),
  render: (input) => `${renderMeta(input.session)}\n\n${fence("session", renderSession(input))}`,
  postValidate(output, input) {
    const gate = quoteGate(output.facts, chunkText(input.chunk));
    const secrets = gate.kept.filter(statesSecret);
    const seen = new Set<string>();
    const unique = gate.kept.filter((f) => {
      const key = normaliseForMatch(f.statement).toLowerCase();
      return statesSecret(f) || seen.has(key) ? false : (seen.add(key), true);
    });
    // Over the cap: keep the 12 highest-priority facts, in the order the model gave them.
    const keep = new Set([...unique].sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind)).slice(0, MAX_FACTS_PER_CHUNK));
    const facts = unique.filter((f) => keep.has(f));

    const notes: string[] = [];
    if (gate.dropped.length) notes.push(`quote gate dropped ${gate.dropped.length}: ${gate.dropped.map((f) => JSON.stringify(f.quote.slice(0, 60))).join(", ")}`);
    if (secrets.length) notes.push(`dropped ${secrets.length} fact(s) stating a credential`);
    const repeats = gate.kept.length - secrets.length - unique.length;
    if (repeats) notes.push(`dropped ${repeats} repeated statement(s)`);
    if (unique.length > facts.length) notes.push(`dropped ${unique.length - facts.length} fact(s) over the cap of ${MAX_FACTS_PER_CHUNK}`);
    return { ok: true, output: { facts }, dropped: output.facts.length - facts.length, notes };
  },
  noop: () => ({ facts: [] }),
});
