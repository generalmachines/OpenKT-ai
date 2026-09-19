// Tagging (Spec 02 §4): slugs converge on the team's own vocabulary.

const KIND_NAMES = new Set([
  "decision",
  "fact",
  "how-to",
  "issue",
  "question",
  "action",
  "idea",
]);

const MAX_TAG_CHARS = 32;
const MERGE_SIMILARITY = 0.85;
const MAX_TAGS = 4;

export function slugTag(raw: string): string | null {
  // NFKD, strip Latin combining marks only (U+0300–U+036F) so `Décision` →
  // `decision`, recompose (NFC) — Thai and Devanagari marks must survive.
  const folded = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase();
  const slug = folded
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG_CHARS)
    .replace(/-$/, "");
  if (slug === "" || KIND_NAMES.has(slug)) return null;
  return slug;
}

export interface VocabEntry {
  tag: string;
  count: number;
}

export function normaliseTags(
  proposed: string[],
  vocab: VocabEntry[],
  similarity: (a: string, b: string) => number,
): { tags: string[]; created: string[] } {
  const tags: string[] = [];
  const brandNew = new Set<string>();
  for (const raw of proposed) {
    const slug = slugTag(raw);
    if (slug === null) continue;
    if (tags.includes(slug)) continue;

    const known = vocab.find((v) => v.tag === slug);
    if (known) {
      tags.push(slug);
      continue;
    }

    let best: { tag: string; sim: number } | null = null;
    for (const v of vocab) {
      const sim = similarity(slug, v.tag);
      if (sim >= MERGE_SIMILARITY && (best === null || sim > best.sim)) {
        best = { tag: v.tag, sim };
      }
    }
    if (best) {
      if (!tags.includes(best.tag)) tags.push(best.tag);
      continue;
    }

    tags.push(slug);
    brandNew.add(slug);
  }
  // `created` lists only new tags actually returned (after the first-4 cut).
  const returned = tags.slice(0, MAX_TAGS);
  return { tags: returned, created: returned.filter((t) => brandNew.has(t)) };
}
