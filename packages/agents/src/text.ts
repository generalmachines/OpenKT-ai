// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
// Deterministic text helpers shared by every agent.
import type { SessionChunk, SessionMeta } from "./types.js";

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Removes reasoning blocks: closed, unclosed (truncated), or closing-tag-only (template opened it). */
export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) out = out.slice(close + "</think>".length);
  const open = out.toLowerCase().indexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

/** Parses the model's reply as one JSON value, tolerating think blocks, code fences and stray prose. */
export function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const cleaned = stripThink(text)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!cleaned) return { ok: false, error: "empty reply" };
  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));
  let error = "";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (e) {
      error ||= (e as Error).message;
    }
  }
  return { ok: false, error: `reply is not valid JSON: ${error}` };
}

/** Normalisation for the quote gate: whitespace, quote marks, dashes, ellipses, zero-width characters. */
export function normaliseForMatch(text: string): string {
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

/** Every fence tag an agent uses. Input may not contain any of them intact. */
const FENCE_LABELS = [
  "session", "metadata", "context", "instruction", "fact", "vocabulary", "new_fact", "neighbours", "facts", "pages",
  "section", "superseded_ids", "caption", "ocr_text", "recent_changes",
];
const FENCE_TAG = new RegExp(`<(/?)(${FENCE_LABELS.join("|")})(?=[\\s>/])`, "gi");

/**
 * Wraps untrusted content in a fence: <session> … </session>. Any fence tag inside the content is broken
 * with a zero-width space so the content cannot close its fence or open another; the quote gate strips
 * zero-width characters, so quotes still match.
 */
export function fence(label: string, content: string): string {
  if (!FENCE_LABELS.includes(label)) throw new Error(`unknown fence label "${label}" — add it to FENCE_LABELS`);
  return `<${label}>\n${content.replace(FENCE_TAG, "<\u200B$1$2")}\n</${label}>`;
}

export function fenceJson(label: string, value: unknown): string {
  return fence(label, JSON.stringify(value, null, 1));
}

/** The text the quote gate searches: turn texts only — no labels, numbers or metadata. */
export function chunkText(chunk: SessionChunk): string {
  return typeof chunk === "string" ? chunk : chunk.map((t) => t.text).join("\n");
}

/** How a chunk is shown to the model: numbered turns with role and speaker. */
export function renderChunk(chunk: SessionChunk, offset = 0): string {
  if (typeof chunk === "string") return chunk;
  return chunk
    .map((t, i) => `[${offset + i + 1}] ${t.role}${t.speaker ? ` (${t.speaker})` : ""}: ${t.text}`)
    .join("\n");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Metadata block. The weekday is computed here so a small model need not work it out. */
export function renderMeta(meta: SessionMeta): string {
  const lines: string[] = [];
  if (meta.date) {
    const d = new Date(meta.date);
    const day = Number.isNaN(d.getTime()) ? "" : ` (${WEEKDAYS[d.getUTCDay()]})`;
    lines.push(`date: ${meta.date.slice(0, 10)}${day}`);
  } else {
    lines.push("date: unknown — do not write absolute dates for relative expressions");
  }
  if (meta.title) lines.push(`title: ${meta.title}`);
  if (meta.source) lines.push(`source: ${meta.source}`);
  if (meta.author) lines.push(`author (the user; "I" in user turns): ${meta.author}`);
  if (meta.participants?.length) lines.push(`participants: ${meta.participants.join(", ")}`);
  if (meta.space) lines.push(`space: ${meta.space}`);
  return fence("metadata", lines.join("\n"));
}

export function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export const CITATION = /\[\^f:([^\]\s]+)\]/g;

export function citedIds(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(CITATION)].map((m) => m[1]!));
}
