// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { defineAgent } from "../define-agent.js";
import { PROMPTS, SCHEMAS } from "../generated/contract.js";
import { fence, fenceJson } from "../text.js";
import { KINDS, type Kind } from "../types.js";

export interface TagInput {
  fact: { statement: string; kind: Kind };
  /** The space's existing tags with how many facts use each. */
  vocabulary: { tag: string; count: number }[];
}
export interface TagOutput {
  tags: string[];
}

export const MAX_TAGS = 4;
export const MAX_TAG_CHARS = 32;
const VOCABULARY_SHOWN = 150;

/** Spec 02 §4: lowercase, kebab-case, ASCII-folded. "Crème Brûlée!" → "creme-brulee"; non-Latin text folds to "". */
export function kebab(tag: string): string {
  return tag
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const tag = defineAgent<TagInput, TagOutput>({
  name: "tag",
  prompt: PROMPTS.tag,
  schema: SCHEMAS.tag,
  maxTokens: 200,
  render(input) {
    const vocabulary = [...input.vocabulary]
      .sort((a, b) => b.count - a.count)
      .slice(0, VOCABULARY_SHOWN)
      .map((v) => `${v.tag} (${v.count})`)
      .join("\n");
    return `${fenceJson("fact", input.fact)}\n\n${fence("vocabulary", vocabulary || "(empty — no tags exist yet)")}`;
  },
  postValidate(output, input) {
    const existing = new Set(input.vocabulary.map((v) => v.tag));
    const tags: string[] = [];
    const notes: string[] = [];
    for (const raw of output.tags) {
      let t = kebab(raw);
      // Converge on the team's spelling: singular/plural variants map onto the existing tag.
      if (!existing.has(t)) {
        const variant = [`${t}s`, t.replace(/s$/, "")].find((v) => v !== t && existing.has(v));
        if (variant) t = variant;
      }
      if (t !== raw) notes.push(`"${raw}" → "${t}"`);
      // A kind is not a subject; a tag that folds to nothing was not English or transliterated.
      if (t && t.length <= MAX_TAG_CHARS && !(KINDS as readonly string[]).includes(t) && !tags.includes(t)) tags.push(t);
    }
    const kept = tags.slice(0, MAX_TAGS);
    if (!kept.length) return { ok: false, error: "no usable tag: return 1 to 4 lowercase kebab-case tags in English or Latin transliteration, none of them a kind name" };
    return { ok: true, output: { tags: kept }, dropped: output.tags.length - kept.length, notes };
  },
  noop: () => ({ tags: [] }),
});
