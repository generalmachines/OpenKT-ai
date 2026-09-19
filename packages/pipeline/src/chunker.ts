// Chunking (Spec 02 §2): sessions are cut into chunks of at most 6,000
// characters before extraction. Pure code — no model, no clock.

import type { Turn } from "./types.js";

export interface Chunk {
  index: number;
  turns: Turn[];
  overlap: Turn[];
  text: string;
}

export interface ChunkTurnsOptions {
  maxChars?: number;
  overlapTurns?: number;
}

const CODE_FENCE = /^(```|~~~)(.*)$/;
const EXTRACT_MIN_CHARS = 200;
const OVERLAP_MARKER = "[context — already processed]";
const NEW_MARKER = "[new]";

/** Replace a fenced code block longer than 40 lines with a one-line marker. */
function clampCodeBlocks(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = CODE_FENCE.exec(lines[i] as string);
    if (!open) {
      out.push(lines[i] as string);
      i++;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^(```|~~~)/.test(lines[j] as string)) {
        close = j;
        break;
      }
    }
    const blockLines = close === -1 ? lines.length - 1 - i : close - i - 1;
    if (blockLines > 40) {
      const lang = open[2]?.trim() || "text";
      out.push(`[code omitted: ${blockLines} lines, ${lang}]`);
      i = close === -1 ? lines.length : close + 1;
    } else {
      const end = close === -1 ? lines.length : close + 1;
      for (let j = i; j < end; j++) out.push(lines[j] as string);
      i = end;
    }
  }
  return out.join("\n");
}

/** Drop system turns and clamp oversized code blocks. Returns a new array. */
function preClean(turns: Turn[]): Turn[] {
  return turns
    .filter((t) => t.role !== "system")
    .map((t) => ({ ...t, content: clampCodeBlocks(t.content) }));
}

/** False when the cleaned user+assistant+speaker+note text totals under 200 characters. */
export function shouldExtract(turns: Turn[]): boolean {
  let total = 0;
  for (const t of preClean(turns)) {
    if (t.role === "user" || t.role === "assistant" || t.role === "speaker" || t.role === "note") {
      total += t.content.length;
    }
  }
  return total >= EXTRACT_MIN_CHARS;
}

/**
 * Split one oversized turn's content into pieces, each fitting maxChars.
 * Split on blank lines first, then on sentence ends, then hard-split. The
 * pieces concatenate back to the original content exactly.
 */
function splitIntoPieces(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];

  const pieces: string[] = [];
  const blocks = content.split(/(\n\n+)/); // alternating text, blank line
  for (let b = 0; b < blocks.length; b += 2) {
    const block = blocks[b] ?? "";
    const sep = blocks[b + 1] ?? "";
    if (block.length + sep.length <= maxChars) {
      pieces.push(block + sep);
      continue;
    }
    const sentences = block.match(/[\s\S]*?[.!?]+["')\]]*(?=\s|$)|[\s\S]+$/g) ?? [block];
    for (const s of sentences) {
      if (s.length <= maxChars) {
        pieces.push(s);
      } else {
        for (let i = 0; i < s.length; i += maxChars) pieces.push(s.slice(i, i + maxChars));
      }
    }
    // The separator can be a huge run of blank lines — hard-split it too.
    if (sep) {
      for (let i = 0; i < sep.length; i += maxChars) pieces.push(sep.slice(i, i + maxChars));
    }
  }
  return pieces;
}

/** Split one oversized turn into parts that each fit maxChars, keeping seq. */
function splitLongTurn(turn: Turn, maxChars: number): Turn[] {
  const pieces = splitIntoPieces(turn.content, maxChars);
  if (pieces.length === 1) return [turn];

  // Pack pieces greedily into parts of at most maxChars.
  const parts: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > maxChars) {
      parts.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) parts.push(current);

  return parts.map((part, i) => ({ ...turn, content: part, part: i + 1 }));
}

function renderTurn(t: Turn): string {
  const speaker = t.speaker ?? t.role;
  return `${speaker}: ${t.content}`;
}

export function chunkTurns(turns: Turn[], opts?: ChunkTurnsOptions): Chunk[] {
  const maxChars = opts?.maxChars ?? 6000;
  const overlapTurns = opts?.overlapTurns ?? 2;

  const cleaned = preClean(turns);
  const expanded: Turn[] = [];
  for (const t of cleaned) expanded.push(...splitLongTurn(t, maxChars));

  const chunks: { turns: Turn[] }[] = [];
  let current: Turn[] = [];
  let size = 0;
  for (const t of expanded) {
    if (size + t.content.length > maxChars && current.length > 0) {
      chunks.push({ turns: current });
      current = [];
      size = 0;
    }
    current.push(t);
    size += t.content.length;
  }
  if (current.length > 0) chunks.push({ turns: current });

  return chunks.map((c, i) => {
    // `slice(-0)` would return the whole array — guard the 0 case.
    const overlap = i === 0 || overlapTurns <= 0 ? [] : chunks[i - 1]!.turns.slice(-overlapTurns);
    const lines: string[] = [];
    if (overlap.length > 0) {
      lines.push(OVERLAP_MARKER);
      for (const t of overlap) lines.push(renderTurn(t));
    }
    lines.push(NEW_MARKER);
    for (const t of c.turns) lines.push(renderTurn(t));
    return { index: i, turns: c.turns, overlap, text: lines.join("\n") };
  });
}
