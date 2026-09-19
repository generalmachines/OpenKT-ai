// Writing a section (Spec 02 §6): what the write_section agent returns is
// checked by code; a deterministic fallback guarantees the page updates.

const MAX_SECTION_CHARS = 1200;
const CITATION = /\[\^f:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]/g;
const SENTENCE_BREAK = /\. |\? |! |\n/;

/** uuids inside [^f:<uuid>] markers, in order of appearance, lowercased. */
export function parseCitations(md: string): string[] {
  return [...md.matchAll(CITATION)].map((m) => (m[1] as string).toLowerCase());
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

/** Lines that carry prose: headings and empty lines are ignored. */
function proseLines(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !isHeading(l));
}

/** Sentences of a prose line. */
function sentenceSegments(line: string): string[] {
  return line.split(SENTENCE_BREAK).filter((s) => s.trim() !== "");
}

export function validateSection(
  md: string,
  ctx: { inputFactIds: string[]; existingFactIds: string[]; maxChars?: number },
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const maxChars = ctx.maxChars ?? MAX_SECTION_CHARS;

  if (md.length > maxChars) errors.push("too_long");

  const cited = new Set(parseCitations(md));
  const inputs = new Set(ctx.inputFactIds.map((id) => id.toLowerCase()));
  const existing = new Set(ctx.existingFactIds.map((id) => id.toLowerCase()));

  for (const line of proseLines(md)) {
    for (const sentence of sentenceSegments(line)) {
      if (parseCitations(sentence).length === 0) errors.push("uncited_sentence");
    }
  }

  for (const id of ctx.inputFactIds) {
    if (!cited.has(id.toLowerCase())) errors.push(`missing_fact:${id}`);
  }
  for (const id of cited) {
    if (!inputs.has(id) && !existing.has(id)) errors.push(`unknown_citation:${id}`);
  }

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}

/** Deterministic fallback: one bullet per fact (Spec 02 §6). */
export function fallbackAppend(
  currentMd: string,
  facts: { id: string; statement: string }[],
): string {
  const lines = facts.map(({ id, statement }) => {
    const cleaned = statement.trim().replace(/\.+$/, "");
    return `- ${cleaned} [^f:${id}]`;
  });
  return `${currentMd.trimEnd()}\n${lines.join("\n")}`;
}
