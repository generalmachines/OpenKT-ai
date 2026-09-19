import { Injectable } from "@nestjs/common";

// HTML renderer for MCP-UI tool responses.
//
// Design system mirrors the openkt dashboard (masti-ai/openkt):
//   - Nunito Sans body, Bitter headings (Google Fonts CDN)
//   - Warm palette: --warm-50 → --warm-900 (#faf8f5 → #2a251d)
//   - Accent #c06830 (terracotta), light variant #e8956a
//   - LIGHT ONLY — dashboard removed dark mode 2026-04-19, no
//     `dark:` variants or prefers-color-scheme blocks
//   - Card pattern: bg-white, border --warm-200, rounded-md, hover
//     border --warm-300 (matches MemoryCard.tsx)
//   - Kind chips: hash-keyed palette (amber/blue/emerald/violet/
//     rose/cyan/orange), identical to dashboard MemoryCard chips
//
// All HTML is self-contained — no external stylesheets, fonts load
// directly from fonts.googleapis.com (allowed in MCP-UI iframes).
// Animations live in scoped <style> blocks under #${scopeId} so
// stacked cards in one conversation don't collide.

const PALETTE = {
  warm50: "#faf8f5",
  warm100: "#f3efe8",
  warm200: "#e8e1d5",
  warm300: "#d5cabb",
  warm400: "#b8a994",
  warm500: "#9a8b76",
  warm600: "#7d6f5c",
  warm700: "#5e5345",
  warm800: "#423b30",
  warm900: "#2a251d",
  accent: "#c06830",
  accentLight: "#e8956a",
  accentMuted: "#d4a07a",
} as const;

// Hash-keyed kind chip palette — identical to dashboard MemoryCard.tsx.
const CHIP_PALETTE = [
  { bg: "#fffbeb", fg: "#b45309" }, // amber
  { bg: "#eff6ff", fg: "#1d4ed8" }, // blue
  { bg: "#ecfdf5", fg: "#047857" }, // emerald
  { bg: "#f5f3ff", fg: "#6d28d9" }, // violet
  { bg: "#fff1f2", fg: "#be123c" }, // rose
  { bg: "#ecfeff", fg: "#0e7490" }, // cyan
  { bg: "#fff7ed", fg: "#c2410c" }, // orange
];

function chipColor(kind: string): { bg: string; fg: string } {
  if (!kind) return { bg: PALETTE.warm100, fg: PALETTE.warm600 };
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) | 0;
  return CHIP_PALETTE[Math.abs(h) % CHIP_PALETTE.length];
}

interface MemoryLike {
  id: string;
  kind: string;
  content?: string;
  content_preview?: string;
  importance?: number | null;
  importance_now?: number | null;
  tags?: Array<{ slug: string } | string>;
  topics?: string[];
  created_at?: string | Date;
  similarity?: number;
}

interface RecallResultLike {
  query?: string;
  memories?: MemoryLike[];
  results?: MemoryLike[];
  total_count?: number;
}

interface ProjectBriefLike {
  project_id?: string;
  project_slug?: string | null;
  summary?: string | null;
  highlights?: Array<{ title: string; body?: string }>;
  members?: Array<{ display_name?: string | null; user_id: string }>;
  updated_at?: string | Date | null;
}

interface ProjectListLike {
  count?: number;
  projects?: Array<{
    id: string;
    slug?: string;
    name?: string;
    visibility?: string;
    role?: string | null;
  }>;
}

interface SavedMemoryLike {
  id: string;
  kind: string;
  content?: string;
  content_preview?: string;
  importance?: number | null;
  tags?: Array<{ slug: string } | string>;
  topics?: string[];
  project_id?: string;
}

@Injectable()
export class McpUiRendererService {
  renderRecall(data: RecallResultLike, query: string): string {
    const memories = data.memories ?? data.results ?? [];
    const total = data.total_count ?? memories.length;
    const id = `recall-${randomId()}`;
    const items = memories.map((m, i) => this.renderMemoryRow(m, i)).join("");
    return this.envelope(
      id,
      `
        <div class="kt-head">
          <p class="kt-eyebrow">Recall</p>
          <h2 class="kt-title">${escapeHtml(query)}</h2>
          <p class="kt-meta">${total} ${total === 1 ? "memory" : "memories"} · ranked by relevance</p>
        </div>
        <div class="kt-list">
          ${items || `<div class="kt-empty">No memories matched. Save one with <code>kt_save_memory</code>.</div>`}
        </div>
      `,
    );
  }

  renderProjectBrief(data: ProjectBriefLike): string {
    const id = `brief-${randomId()}`;
    const highlights = (data.highlights ?? [])
      .slice(0, 6)
      .map(
        (h) => `
        <div class="kt-row">
          <p class="kt-row-title">${escapeHtml(h.title)}</p>
          ${h.body ? `<p class="kt-row-body">${escapeHtml(h.body)}</p>` : ""}
        </div>
      `,
      )
      .join("");
    const members = (data.members ?? [])
      .slice(0, 5)
      .map(
        (m) =>
          `<span class="kt-member">${escapeHtml(
            m.display_name ?? m.user_id.slice(0, 8),
          )}</span>`,
      )
      .join("");
    return this.envelope(
      id,
      `
        <div class="kt-head">
          <p class="kt-eyebrow">Project brief</p>
          <h2 class="kt-title">${escapeHtml(data.project_slug ?? data.project_id ?? "Project")}</h2>
          ${data.summary ? `<p class="kt-summary">${escapeHtml(data.summary)}</p>` : ""}
        </div>
        ${highlights ? `<div class="kt-list">${highlights}</div>` : ""}
        ${
          members
            ? `<div class="kt-members"><p class="kt-eyebrow" style="margin-bottom:6px">Active</p>${members}</div>`
            : ""
        }
        <p class="kt-foot">Auto-maintained · refreshes every 5 min</p>
      `,
    );
  }

  renderProjectList(data: ProjectListLike): string {
    const id = `projects-${randomId()}`;
    const projects = data.projects ?? [];
    const rows = projects
      .map(
        (p) => `
        <div class="kt-row kt-row-flex">
          <div>
            <p class="kt-row-title">${escapeHtml(p.name ?? p.slug ?? p.id)}</p>
            <p class="kt-row-meta">${escapeHtml(p.slug ?? p.id.slice(0, 8))} · ${escapeHtml(p.visibility ?? "project")}</p>
          </div>
          ${p.role ? `<span class="kt-pill">${escapeHtml(p.role)}</span>` : ""}
        </div>
      `,
      )
      .join("");
    return this.envelope(
      id,
      `
        <div class="kt-head">
          <p class="kt-eyebrow">Projects</p>
          <h2 class="kt-title">${data.count ?? projects.length} ${(data.count ?? projects.length) === 1 ? "workspace" : "workspaces"}</h2>
          <p class="kt-meta">Pick a project_id or project_slug to scope your next call.</p>
        </div>
        <div class="kt-list">
          ${rows || '<div class="kt-empty">No projects yet. Create one in the dashboard.</div>'}
        </div>
      `,
    );
  }

  renderSaved(data: SavedMemoryLike): string {
    const id = `saved-${randomId()}`;
    const chip = chipColor(data.kind);
    const tags = collectTags(data).map((slug) => this.renderTag(slug)).join("");
    const preview = data.content_preview ?? data.content ?? "";
    return this.envelope(
      id,
      `
        <div class="kt-confirm">
          <div class="kt-check">✓</div>
          <div>
            <p class="kt-eyebrow">Saved</p>
            <p class="kt-confirm-kind"><span class="kt-chip" style="background:${chip.bg};color:${chip.fg}">${escapeHtml(data.kind)}</span></p>
          </div>
        </div>
        <div class="kt-preview">${escapeHtml(truncate(preview, 240))}</div>
        ${tags ? `<div class="kt-tags">${tags}</div>` : ""}
        <p class="kt-foot">Memory id <code>${escapeHtml(data.id.slice(0, 8))}</code></p>
      `,
    );
  }

  private renderMemoryRow(m: MemoryLike, idx: number): string {
    const imp = (m.importance_now ?? m.importance ?? 0.5) * 100;
    const chip = chipColor(m.kind);
    const tags = collectTags(m).slice(0, 4).map((slug) => this.renderTag(slug)).join("");
    const preview = m.content_preview ?? m.content ?? "";
    const sim =
      typeof m.similarity === "number"
        ? `<span class="kt-sim">${(m.similarity * 100).toFixed(0)}%</span>`
        : "";
    return `
      <div class="kt-item" style="animation-delay:${idx * 60}ms">
        <div class="kt-item-head">
          <span class="kt-chip" style="background:${chip.bg};color:${chip.fg}">${escapeHtml(m.kind)}</span>
          ${sim}
        </div>
        <p class="kt-item-body">${escapeHtml(truncate(preview, 200))}</p>
        <div class="kt-item-foot">
          <div class="kt-bar" title="importance ${imp.toFixed(0)}%">
            <div class="kt-bar-fill" style="width:${imp}%"></div>
          </div>
          ${tags ? `<div class="kt-tags">${tags}</div>` : ""}
        </div>
      </div>
    `;
  }

  private renderTag(slug: string): string {
    return `<span class="kt-tag">${escapeHtml(slug)}</span>`;
  }

  private envelope(scopeId: string, inner: string): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>OpenKT</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@500;600&family=Nunito+Sans:opsz,wght@6..12,400;6..12,500;6..12,600&display=swap" rel="stylesheet">
<style>
  /* Scope all selectors under #${scopeId} so multiple cards in the
     same conversation don't bleed into each other. Palette mirrors
     the dashboard tokens exactly. Light only — no dark mode. */
  #${scopeId} {
    font-family: 'Nunito Sans', system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    color: ${PALETTE.warm800};
    background: ${PALETTE.warm50};
    padding: 18px 20px;
    border-radius: 10px;
    border: 1px solid ${PALETTE.warm200};
    max-width: 720px;
    margin: 6px 0;
    animation: kt-fade-in 240ms ease-out;
  }
  @keyframes kt-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes kt-row-in {
    from { opacity: 0; transform: translateX(-4px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes kt-check-pop {
    from { transform: scale(0); }
    to   { transform: scale(1); }
  }
  #${scopeId} .kt-head { margin-bottom: 12px; }
  #${scopeId} .kt-eyebrow {
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: ${PALETTE.warm500};
    margin: 0;
  }
  #${scopeId} .kt-title {
    font-family: 'Bitter', Georgia, serif;
    font-weight: 500;
    font-size: 20px;
    color: ${PALETTE.warm900};
    margin: 4px 0 4px;
    line-height: 1.2;
  }
  #${scopeId} .kt-meta, #${scopeId} .kt-row-meta {
    font-size: 12px;
    color: ${PALETTE.warm500};
    margin: 0;
  }
  #${scopeId} .kt-summary {
    font-size: 13px;
    color: ${PALETTE.warm700};
    margin-top: 6px;
    line-height: 1.55;
  }
  #${scopeId} .kt-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  #${scopeId} .kt-item, #${scopeId} .kt-row {
    background: white;
    border: 1px solid ${PALETTE.warm200};
    border-radius: 8px;
    padding: 12px 14px;
    animation: kt-row-in 240ms ease-out backwards;
    transition: border-color 120ms ease;
  }
  #${scopeId} .kt-item:hover, #${scopeId} .kt-row:hover {
    border-color: ${PALETTE.warm300};
  }
  #${scopeId} .kt-row-flex {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  #${scopeId} .kt-row-title {
    font-weight: 600;
    font-size: 14px;
    color: ${PALETTE.warm900};
    margin: 0;
  }
  #${scopeId} .kt-row-body {
    font-size: 12px;
    color: ${PALETTE.warm600};
    margin: 4px 0 0;
    line-height: 1.55;
  }
  #${scopeId} .kt-item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  #${scopeId} .kt-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }
  #${scopeId} .kt-sim {
    font-size: 11px;
    font-weight: 600;
    color: ${PALETTE.accent};
    background: color-mix(in oklab, ${PALETTE.accent} 10%, transparent);
    padding: 2px 7px;
    border-radius: 999px;
  }
  #${scopeId} .kt-item-body {
    margin: 8px 0 10px;
    font-size: 13px;
    color: ${PALETTE.warm800};
    line-height: 1.55;
  }
  #${scopeId} .kt-item-foot {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  #${scopeId} .kt-bar {
    flex: 1;
    height: 3px;
    background: ${PALETTE.warm100};
    border-radius: 2px;
    overflow: hidden;
  }
  #${scopeId} .kt-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, ${PALETTE.accent}, ${PALETTE.accentLight});
    transition: width 800ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  #${scopeId} .kt-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  #${scopeId} .kt-tag {
    font-size: 11px;
    font-weight: 500;
    background: ${PALETTE.warm100};
    color: ${PALETTE.warm700};
    padding: 2px 7px;
    border-radius: 999px;
  }
  #${scopeId} .kt-pill {
    font-size: 11px;
    font-weight: 500;
    background: color-mix(in oklab, ${PALETTE.accent} 10%, transparent);
    color: ${PALETTE.accent};
    padding: 3px 9px;
    border-radius: 4px;
    text-transform: lowercase;
  }
  #${scopeId} .kt-empty {
    padding: 18px;
    text-align: center;
    color: ${PALETTE.warm500};
    font-size: 13px;
  }
  #${scopeId} .kt-empty code {
    background: ${PALETTE.warm100};
    color: ${PALETTE.warm700};
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
  }
  #${scopeId} .kt-foot {
    font-size: 11px;
    color: ${PALETTE.warm500};
    margin: 12px 0 0;
  }
  #${scopeId} .kt-foot code {
    background: ${PALETTE.warm100};
    color: ${PALETTE.warm700};
    padding: 1px 5px;
    border-radius: 3px;
  }
  #${scopeId} .kt-confirm {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  #${scopeId} .kt-check {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: ${PALETTE.accent};
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    animation: kt-check-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  #${scopeId} .kt-confirm-kind {
    margin: 2px 0 0;
    font-size: 14px;
  }
  #${scopeId} .kt-preview {
    font-size: 13px;
    line-height: 1.55;
    padding: 10px 12px;
    background: white;
    border: 1px solid ${PALETTE.warm200};
    border-radius: 6px;
    margin: 8px 0;
  }
  #${scopeId} .kt-members {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 12px;
    align-items: center;
  }
  #${scopeId} .kt-member {
    font-size: 12px;
    background: white;
    border: 1px solid ${PALETTE.warm200};
    padding: 3px 9px;
    border-radius: 999px;
    color: ${PALETTE.warm700};
  }
  #${scopeId} code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
</style></head><body>
<div id="${scopeId}">${inner}</div>
</body></html>`;
  }
}

function collectTags(m: MemoryLike | SavedMemoryLike): string[] {
  const fromTags = (m.tags ?? [])
    .map((t) => (typeof t === "string" ? t : t.slug))
    .filter((s): s is string => Boolean(s));
  const fromTopics = (m.topics ?? []).filter((s): s is string => typeof s === "string");
  // Topics is what the dashboard renders for chips on MemoryCard. Tags
  // is the structured slug list. Whichever the caller has, surface it.
  return fromTopics.length > 0 ? fromTopics : fromTags;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
