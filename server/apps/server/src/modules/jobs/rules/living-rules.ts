// The deterministic rules the server re-applies to a job result that came back
// from a member's Mac (Spec 02). The Mac runs the same rules before it posts —
// they live in @openkt/pipeline and @openkt/agents — but the server never trusts
// a result it did not check: a quote that is not in the session, a secret, a
// citation from another space or a write to a locked section is refused here.
//
// These are copies, not imports: the server image builds from server/ only and
// cannot resolve the workspace packages (see common/secrets/find-secrets.ts for
// the same arrangement). Where a rule came from a contributor's pull request,
// the note says which.

export const KINDS = ["decision", "fact", "how-to", "issue", "question", "action", "idea"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** Spec 02 §2: facts kept per session. */
export const MAX_FACTS_PER_SESSION = 60;
/** Spec 01 §5 page limits. */
export const SECTION_MAX_CHARS = 1200;
export const PAGE_MAX_SECTIONS = 8;
export const PAGE_TITLE_MAX_CHARS = 60;
export const BRIEF_MAX_CHARS = 1500;
/** Spec 01 §5: brief regenerated at most once every 10 minutes per space. */
export const BRIEF_DEBOUNCE_MS = 10 * 60_000;
/** Spec 02 §3 thresholds. */
export const DUPLICATE_AT = 0.97;
export const ASK_AGENT_AT = 0.82;
export const MAX_SUPERSEDES = 3;
/** Spec 02 §5 step 1: candidate pages. */
export const CANDIDATE_SECTION_SIMILARITY = 0.55;
export const MAX_CANDIDATE_PAGES = 8;
/** Shorter quotes match almost anything and prove nothing (packages/agents MIN_QUOTE_CHARS). */
export const MIN_QUOTE_CHARS = 8;
export const MAX_TAGS = 4;
export const MAX_TAG_CHARS = 32;

// ── quote gate (Spec 01 §5) — normaliseForMatch() of packages/agents/src/text.ts ──

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export function normaliseForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/** The quote is a verbatim passage of one turn, after normalising whitespace and quote marks. */
export function quoteFound(quote: string, turnTexts: string[]): { found: boolean; turnIndex: number } {
  const needle = normaliseForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return { found: false, turnIndex: -1 };
  const turnIndex = turnTexts.findIndex((t) => normaliseForMatch(t).includes(needle));
  if (turnIndex >= 0) return { found: true, turnIndex };
  // A quote may also span the joint of two turns' text; accept it against the whole session.
  return { found: normaliseForMatch(turnTexts.join("\n")).includes(needle), turnIndex: -1 };
}

// ── kinds (Spec 02 §7) — mapKind() from PR #56 (J22) ──

export type DbKind = "decision" | "fact" | "pattern" | "incident" | "note";

export function mapKind(kind: Kind): { dbKind: DbKind; extraTags: string[] } {
  switch (kind) {
    case "decision":
      return { dbKind: "decision", extraTags: [] };
    case "fact":
      return { dbKind: "fact", extraTags: [] };
    case "how-to":
      return { dbKind: "pattern", extraTags: [] };
    case "issue":
      return { dbKind: "incident", extraTags: [] };
    case "question":
      return { dbKind: "note", extraTags: ["open-question"] };
    case "action":
      return { dbKind: "note", extraTags: ["action"] };
    case "idea":
      return { dbKind: "note", extraTags: ["idea"] };
  }
}

/** The product kind of a stored fact (the inverse of mapKind). */
export function unmapKind(dbKind: string, tags: string[]): Kind {
  if (dbKind === "note") {
    if (tags.includes("open-question")) return "question";
    if (tags.includes("action")) return "action";
    if (tags.includes("idea")) return "idea";
    return "fact";
  }
  return ({ decision: "decision", fact: "fact", pattern: "how-to", incident: "issue" } as Record<string, Kind>)[dbKind] ?? "fact";
}

// ── confidence (Spec 02 §8) — assignConfidence() from PR #62 (J27), the rows used here ──

export function extractedConfidence(quoteTurnRole: string | null): number {
  if (quoteTurnRole === "user") return 0.75;
  if (quoteTurnRole === "assistant") return 0.55;
  return 0.5;
}

/** "later confirmed (another session yields a duplicate ≥ 0.97)": +0.10, cap 0.95. */
export function confirmedConfidence(current: number): number {
  return Math.min(0.95, Math.round((current + 0.1) * 100) / 100);
}

// ── tags (Spec 02 §4) — slugTag() from PR #59 (J24), with the code-point cut from its review ──

export function slugTag(raw: string): string | null {
  const folded = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase();
  const dashed = folded.replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const slug = Array.from(dashed).slice(0, MAX_TAG_CHARS).join("").replace(/-+$/, "");
  if (slug === "" || (KINDS as readonly string[]).includes(slug)) return null;
  return slug;
}

// ── supersede guards (Spec 02 §3) — guardSupersede() from PR #57 (J23), with its review applied ──

export interface SupersedeCandidate {
  id: string;
  project_id: string;
  created_at: string;
  owner_user_id: string;
  is_pinned: boolean;
}

const MAY_SUPERSEDE_PROTECTED: readonly Kind[] = ["decision", "fact", "how-to"];

export function guardSupersede(
  fact: { kind: Kind; created_at: string; project_id: string; owner_user_id: string },
  proposed: string[],
  candidates: SupersedeCandidate[],
): { supersedes: string[]; rejected: { id: string; reason: string }[] } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rejected: { id: string; reason: string }[] = [];
  const valid: string[] = [];
  const at = Date.parse(fact.created_at);
  for (const id of [...new Set(proposed)]) {
    const target = byId.get(id);
    if (!target) {
      rejected.push({ id, reason: "unknown_id" });
      continue;
    }
    const targetAt = Date.parse(target.created_at);
    if (Number.isNaN(at) || Number.isNaN(targetAt)) {
      rejected.push({ id, reason: "bad_date" });
      continue;
    }
    if (!(targetAt < at)) {
      rejected.push({ id, reason: "not_older" });
      continue;
    }
    if (target.project_id !== fact.project_id) {
      rejected.push({ id, reason: "other_project" });
      continue;
    }
    if ((target.is_pinned || target.owner_user_id !== fact.owner_user_id) && !MAY_SUPERSEDE_PROTECTED.includes(fact.kind)) {
      rejected.push({ id, reason: "protected_target" });
      continue;
    }
    valid.push(id);
  }
  if (valid.length > MAX_SUPERSEDES) {
    return { supersedes: [], rejected: [...rejected, ...valid.map((id) => ({ id, reason: "suspicious_supersede" }))] };
  }
  return { supersedes: valid, rejected };
}

// ── sections (Spec 02 §6) ──

export const CITATION = /\[\^f:([0-9a-fA-F-]{36})\]/g;

export function citedIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(CITATION)].map((m) => m[1]!.toLowerCase()))];
}

/** Prose blocks: paragraphs and list items; headings, rules, tables and code are not prose. */
export function proseBlocks(markdown: string): string[] {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)/)
    .map((b) => b.trim())
    .filter((b) => b && !/^(#{1,6}\s|[-*_]{3,}\s*$|\|)/.test(b));
}

/**
 * Removes every prose block that cites one of `dropped` (a fact the server refused), so a
 * sentence never survives without the fact it rests on. Other markdown is kept as written.
 */
export function withoutBlocksCiting(markdown: string, dropped: Set<string>): string {
  if (!dropped.size) return markdown.trim();
  const parts = markdown.split(/(\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s))/);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const block = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    if (citedIds(block).some((id) => dropped.has(id))) continue;
    kept.push(block + sep);
  }
  return kept.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export type SectionCheck = { ok: true } | { ok: false; reason: string };

/**
 * A section body an agent wrote: at most 1,200 characters, every prose block cites at least one
 * fact, and every cited fact is one this space may cite.
 */
export function checkAgentSection(body: string, citable: Set<string>): SectionCheck {
  if (!body.trim()) return { ok: false, reason: "empty" };
  if (body.length > SECTION_MAX_CHARS) return { ok: false, reason: "too_long" };
  const uncited = proseBlocks(body).find((b) => citedIds(b).length === 0);
  if (uncited) return { ok: false, reason: "uncited_sentence" };
  const foreign = citedIds(body).find((id) => !citable.has(id));
  if (foreign) return { ok: false, reason: "citation_not_in_space" };
  return { ok: true };
}

/** Spec 02 §6 fallback: one bullet per fact. The page is never left unchanged because a model misbehaved. */
export function deterministicAppend(current: string, facts: { id: string; statement: string }[]): string {
  const bullets = facts.map((f) => `- ${f.statement.trim().replace(/\s+/g, " ")} [^f:${f.id}]`).join("\n");
  const head = current.trim();
  if (!bullets) return head;
  return head ? `${head}\n\n${bullets}` : bullets;
}

/** Text with the citation markers removed, for summaries and embeddings. */
export function stripCitations(markdown: string): string {
  return markdown.replace(/\s*\[\^f:[^\]\s]+\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

/** Spec 02 §6: pages.summary = first 240 characters of the first section, no model. */
export function pageSummary(firstSectionBody: string): string {
  const text = stripCitations(firstSectionBody).replace(/^[-*+]\s+/gm, "").replace(/\s+/g, " ").trim();
  return Array.from(text).length <= 240 ? text : `${Array.from(text).slice(0, 239).join("").trimEnd()}…`;
}

/** Spec 02 §5: a page title is a noun phrase of at most 60 characters, never a sentence. */
export function pageTitleOk(title: string): boolean {
  const t = title.trim();
  return t.length > 0 && Array.from(t).length <= PAGE_TITLE_MAX_CHARS && !/[.!?。]$/.test(t) && !t.includes("\n");
}

export function pageSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(slug).slice(0, 80).join("").replace(/-+$/, "") || "page";
}

export function sameHeading(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
