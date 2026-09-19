// Spec 04 "MCP tools": every core tool returns a text block a model can use on
// its own, plus the same facts as `structuredContent`. These are the pure
// formatters behind kt_recall, kt_search_memories, kt_save_memory,
// kt_list_projects, kt_project_brief and the session tools.
import type { BriefingResponse } from "../../briefing/contracts/briefing.contract";
import type { MemoryGateSuggestion, MemoryRecord } from "../../memory/contracts/memory.contract";

// Spec 04 RecallItem (facts only; pages come later).
export interface RecallItem {
  id: string;
  type: "fact";
  text: string;
  kind: string;
  tags: string[];
  space: { id: string; name: string };
  author: { id: string; name: string | null };
  session: { id: string; source: string | null } | null;
  source: string | null;
  visibility: string;
  created_at: string;
  score: number | null;
}

type RecalledMemory = MemoryRecord & { similarity?: number | null };

export function toRecallItem(memory: RecalledMemory): RecallItem {
  return {
    id: memory.id,
    type: "fact",
    text: memory.content,
    kind: memory.kind,
    tags: (memory.tags ?? []).map((tag) => tag.slug),
    space: { id: memory.project.id, name: memory.project.name },
    // A name, never an email: other people's emails are only for a resource's owner.
    author: { id: memory.owner.user_id, name: memory.owner.display_name ?? null },
    session: memory.session_id ? { id: memory.session_id, source: memory.source ?? null } : null,
    source: memory.source ?? null,
    visibility: memory.visibility,
    created_at: memory.created_at,
    score: memory.similarity ?? null,
  };
}

// "1. [decision] We chose X — Ana, Hackathon team, claude-code, 2026-09-19 (id …)"
export function recallLine(item: RecallItem, index: number): string {
  const byline = [item.author.name ?? "someone", item.space.name, item.source, item.created_at.slice(0, 10)]
    .filter(Boolean)
    .join(", ");
  return `${index + 1}. [${item.kind}] ${oneLine(item.text)} — ${byline} (id ${item.id})`;
}

export const NOTHING_RELEVANT = "Nothing relevant in the spaces you can read.";

export function recallText(items: RecallItem[], opts: { spaceName?: string | null; recallId?: string } = {}): string {
  if (items.length === 0) {
    return opts.spaceName ? `Nothing relevant in ${opts.spaceName}.` : NOTHING_RELEVANT;
  }
  const where = opts.spaceName ? `in ${opts.spaceName}` : "from the spaces you can read";
  const head = `${items.length} ${items.length === 1 ? "fact" : "facts"} ${where}:`;
  const tail = opts.recallId ? [`recall_id: ${opts.recallId}`] : [];
  return [head, ...items.map(recallLine), ...tail].join("\n");
}

export function savedText(result: MemoryRecord | MemoryGateSuggestion): string {
  if (!("id" in result)) {
    return `Not saved: ${result.reason}` + (result.suggested_skill ? " Save it as a skill instead (kt_save_skill)." : "");
  }
  const who = result.visibility === "personal" ? "only you" : "everyone who can read that space";
  return `Saved to ${result.project.name} — visible to ${who}. id ${result.id}`;
}

export type SpaceRole = "owner" | "editor" | "reader";

export interface SpaceListItem {
  id: string;
  name: string;
  slug: string;
  my_role: SpaceRole;
  is_personal: boolean;
  visibility: string;
}

export function spacesText(spaces: SpaceListItem[]): string {
  if (spaces.length === 0) return "No spaces yet. Omit project to use your personal space.";
  const lines = spaces.map(
    (s, i) => `${i + 1}. ${s.is_personal ? "Personal (only you)" : s.name} — ${s.my_role} — project ${s.slug} (id ${s.id})`,
  );
  return [
    `${spaces.length} ${spaces.length === 1 ? "space" : "spaces"} you can read (writable first):`,
    ...lines,
    "Pass the id (or slug) as project to kt_save_memory / kt_session_start; omit project on kt_recall to search them all.",
  ].join("\n");
}

// A briefing as markdown: summary, key decisions, open questions, themes.
// null when there is nothing in it yet.
export function briefMarkdown(brief: BriefingResponse | null, spaceName: string): string | null {
  if (!brief || (!brief.summary && brief.key_decisions.length === 0 && brief.themes.length === 0)) {
    return null;
  }
  const parts = [`# ${spaceName}`];
  if (brief.summary) parts.push(brief.summary.trim());
  if (brief.key_decisions.length) {
    parts.push("## Key decisions", ...brief.key_decisions.map((d) => `- ${oneLine(d.summary)}`));
  }
  if (brief.open_questions.length) {
    parts.push("## Open questions", ...brief.open_questions.map((q) => `- ${oneLine(q.question)}`));
  }
  if (brief.themes.length) {
    parts.push("## Themes", ...brief.themes.map((t) => `- ${t.name}${t.description ? `: ${oneLine(t.description)}` : ""}`));
  }
  return parts.join("\n\n").replace(/\n\n- /g, "\n- ");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
