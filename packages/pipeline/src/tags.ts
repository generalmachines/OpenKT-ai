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
  const folded = raw.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
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
  const created: string[] = [];
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
    if (!created.includes(slug)) created.push(slug);
  }
  return { tags: tags.slice(0, MAX_TAGS), created };
}
