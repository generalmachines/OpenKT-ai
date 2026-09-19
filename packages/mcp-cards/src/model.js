// Pure data shaping for the cards (no DOM) — unit-tested in test/model.test.mjs.

const KIND_ALIASES = {
  decision: "decision", fact: "fact", "how-to": "how-to", howto: "how-to", question: "question", action: "action", idea: "idea", issue: "issue",
  // kinds still emitted by the current server (MemoryKindSchema)
  pattern: "how-to", skill: "how-to", "debug-recipe": "how-to", incident: "issue", "anti-pattern": "issue",
  context: "fact", environment: "fact", note: "fact", other: "fact",
};
export const kindKey = (kind) => KIND_ALIASES[String(kind || "").toLowerCase()] || "fact";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

export function formatDate(value, now = new Date()) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value); // already a display string such as "today"
  const day = (x) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return d.getDate() + " " + months[d.getMonth()] + (d.getFullYear() === now.getFullYear() ? "" : " " + d.getFullYear());
}

/** "author · source · date" (+ "· space" when results span several spaces). */
export function metaLine(item, withSpace, now) {
  const parts = [item.author, item.source, item.status === "open" ? "open" : "", formatDate(item.date, now)];
  if (withSpace && item.space) parts.push(item.space);
  return parts.filter(Boolean).join(" · ");
}

export function contextText(items) {
  const lines = items.map((it) => "- [" + (it.kind || "fact") + "] " + it.content + " (" + [it.author, it.source, it.space && "space: " + it.space, "id " + it.id].filter(Boolean).join("; ") + ")");
  return "The user selected this OpenKT team context to use in this conversation:\n" + lines.join("\n");
}

/** Arguments for the app-only kt_commit_save tool. Mirrors kt_save_memory so the server can delegate. */
export function commitArgs(draft, option) {
  const args = { content: draft.content, kind: draft.kind || "fact", visibility: option.visibility };
  if (option.project) args.project = option.project;
  if (draft.sessionId) args.session_id = draft.sessionId;
  if (draft.draftId) args.draft_id = draft.draftId;
  return args;
}

function parseTextJson(result) {
  for (const block of (result && result.content) || []) {
    if (block && block.type === "text" && /^\s*[{[]/.test(block.text || "")) {
      try { return JSON.parse(block.text); } catch { /* not JSON */ }
    }
  }
  return null;
}

function normalizeItem(raw, i) {
  const space = raw.space || raw.project || {};
  return {
    id: String(raw.id ?? raw.memory_id ?? "item-" + i),
    kind: str(raw.kind) || "fact",
    content: str(raw.content) || str(raw.statement) || str(raw.text),
    author: str(raw.author && raw.author.name ? raw.author.name : raw.author) || str(raw.author_name),
    source: str(raw.source && raw.source.title ? raw.source.title : raw.source) || str(raw.session_title),
    date: raw.date || raw.created_at || "",
    status: str(raw.status),
    space: str(typeof space === "string" ? space : space.label || space.name || space.slug) || str(raw.space_label) || str(raw.project_name),
  };
}

export function normalize(result, toolArgs) {
  const sc = (result && result.structuredContent) || parseTextJson(result) || {};
  const text = ((result && result.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const args = toolArgs || {};
  // Spec 04 names the results view "search"; both spellings render the same card.
  const view = (sc.view === "search" ? "results" : sc.view) || (sc.draft || sc.statement ? "save" : sc.session ? "session" : sc.items || sc.memories || sc.results ? "results" : "");
  if (result && result.isError) return { view: "message", isError: true, text: text || "The tool call failed." };

  if (view === "save") {
    const d = sc.draft || {};
    const personal = sc.personal || {};
    const options = [];
    const seen = new Set();
    for (const s of Array.isArray(sc.spaces) ? sc.spaces : []) {
      const id = str(String(s.id ?? s.project_id ?? s.slug ?? ""));
      // Defence in depth: the server MUST only send writable spaces, but never offer one flagged otherwise.
      if (!id || seen.has(id) || s.can_write === false || s.writable === false || s.role === "reader") continue;
      seen.add(id);
      options.push({ key: "s:" + id, label: str(s.label) || str(s.name) || str(s.slug) || id, note: str(s.sublabel) || str(s.access_note) || str(s.access_label), project: id, visibility: "project" });
    }
    const me = { key: "me", label: str(personal.label) || "Only me", note: str(personal.sublabel) || "personal space", project: str(personal.project) || str(personal.id), visibility: "personal" };
    const suggestedId = sc.suggested_space_id ?? sc.suggested_space ?? sc.default_space_id;
    let suggestedKey = suggestedId ? "s:" + suggestedId : "me";
    if (!options.some((o) => o.key === suggestedKey)) suggestedKey = "me";
    // Order: suggestion first, then "Only me", then the rest — as in the approved mock.
    const first = options.filter((o) => o.key === suggestedKey);
    const rest = options.filter((o) => o.key !== suggestedKey);
    const page = d.page_hint || sc.page_hint;
    return {
      view: "save",
      draft: {
        content: str(d.content) || str(sc.statement) || str(args.content), kind: str(d.kind) || str(sc.kind) || str(args.kind) || "fact",
        sessionId: str(d.session_id) || str(args.session_id), draftId: str(d.draft_id),
        pageHint: page && str(page.title) ? (page.action === "creates" ? "creates" : "updates") + " page “" + page.title + "”" : "",
      },
      options: [...first, me, ...rest],
      suggestedKey,
    };
  }

  if (view === "results") {
    const rawItems = sc.items || sc.memories || sc.results || [];
    const items = (Array.isArray(rawItems) ? rawItems : []).map(normalizeItem).filter((i) => i.content);
    const scope = sc.space || sc.project;
    return {
      view: "results", query: str(sc.query) || str(args.query), total: typeof sc.total === "number" ? sc.total : null, items,
      scope: str(typeof scope === "string" ? scope : scope && (scope.label || scope.name || scope.slug)) || str(sc.space_label),
    };
  }

  if (view === "session") {
    const s = sc.session || {};
    const saved = (Array.isArray(sc.saved) ? sc.saved : Array.isArray(sc.facts) ? sc.facts : []).map((m) => ({ kind: str(m.kind) || "fact", content: str(m.content), page: str(m.page && m.page.title ? m.page.title : m.page) })).filter((m) => m.content);
    const open = (Array.isArray(sc.open_questions) ? sc.open_questions : []).map((q) => str(typeof q === "string" ? q : q && q.content)).filter(Boolean);
    const counts = sc.counts || {};
    const stats = [];
    stats.push([(counts.saved ?? saved.length) === 1 ? "item kept" : "items kept", String(counts.saved ?? saved.length)]);
    if (counts.recalled != null) stats.push([counts.recalled === 1 ? "recall" : "recalls", String(counts.recalled)]);
    if (counts.pages_updated != null) stats.push([counts.pages_updated === 1 ? "page updated" : "pages updated", String(counts.pages_updated)]);
    const mins = s.started_at && s.ended_at ? Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)) : null;
    if (mins && Number.isFinite(mins)) stats.push(["", mins < 90 ? mins + " min" : Math.round(mins / 6) / 10 + " h"]);
    const space = s.space || s.project || sc.space;
    return {
      view: "session",
      session: { id: str(s.id), title: str(s.title) || str(sc.title), status: str(s.status) || "closed", space: str(typeof space === "string" ? space : space && (space.label || space.name || space.slug)) },
      summary: str(sc.summary) || str(s.summary) || str(args.summary), saved, open, stats,
    };
  }

  return { view: "message", isError: false, text };
}
