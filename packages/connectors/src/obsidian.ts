// Obsidian connector (Spec 05 §3–§4): proves the ingestion pipeline with no
// auth. Containers are the vault's top-level folders; items are `.md` files.
// Everything goes through the ProviderHandle — the connector never touches
// the filesystem itself.

import { createHash } from "node:crypto";

import type { Block, Connector, ExternalItem, SessionDraft, Turn } from "./types.js";

/** Spec 05 §4: items over 200 KB of text are truncated with a marker turn. */
export const MAX_BODY_CHARS = 200 * 1024;
export const TRUNCATION_MARKER = "[truncated: item exceeded 200 KB]";

/** Files a page of `backfill` reads at most; keeps one call from reading a huge vault. */
const BACKFILL_PAGE = 50;

export interface Frontmatter {
  attrs: Record<string, string>;
  body: string;
}

/** Parse a leading `---` YAML frontmatter block (flat `key: value` lines only). */
export function parseFrontmatter(md: string): Frontmatter {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") return { attrs: {}, body: md };
  const attrs: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      return { attrs, body: lines.slice(i + 1).join("\n") };
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) attrs[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  // No closing delimiter — not frontmatter.
  return { attrs: {}, body: md };
}

/** Files with `openkt: false` in frontmatter are skipped entirely. */
export function isSkippedNote(md: string): boolean {
  return parseFrontmatter(md).attrs["openkt"] === "false";
}

/** The note's `openkt-space` frontmatter value, when set (overrides the container's space). */
export function frontmatterSpace(md: string): string | undefined {
  const space = parseFrontmatter(md).attrs["openkt-space"];
  return space === undefined || space === "" ? undefined : space;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One turn per top-level heading section (`# …`), role `'note'` (Spec 05 §4).
 * Nested headings (`##`, `###`) stay inside their section's turn. Content
 * before the first `#` heading is the first turn; a note with no headings is
 * one turn with the whole body.
 */
export function noteToTurns(body: string): Turn[] {
  const lines = body.split("\n");
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#(\s|$)/.test(line)) {
      if (current.length > 0) sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current);

  const turns: Turn[] = [];
  for (const section of sections) {
    const content = section.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    if (content === "") continue;
    turns.push({ seq: turns.length + 1, role: "note", content });
  }
  return turns;
}

function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => (typeof b["content"] === "string" ? b["content"] : typeof b["text"] === "string" ? b["text"] : ""))
    .filter((s) => s !== "")
    .join("\n\n");
}

/** `toSession` per Spec 05 §3: pure, one turn per top-level section, sha256 of the body. */
export function toSession(item: ExternalItem): SessionDraft {
  const md = typeof item.body === "string" ? item.body : blocksToMarkdown(item.body);
  const { body } = parseFrontmatter(md);
  // The hash covers the original body; the turns are built from the
  // truncated text (Spec 05 §4: over 200 KB → truncated with a marker turn).
  const turns = noteToTurns(md.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body);
  if (md.length > MAX_BODY_CHARS) {
    turns.push({ seq: turns.length + 1, role: "note", content: TRUNCATION_MARKER });
  }
  return {
    source: "connector",
    client: "obsidian",
    external_id: item.externalId,
    external_url: item.url,
    title: item.title,
    content_hash: sha256Hex(md),
    turns,
  };
}

function toExternalItem(relPath: string, content: string): ExternalItem {
  const frontmatter = parseFrontmatter(content);
  // The title is the first `#` heading; fall back to the file name.
  const heading = /^# (.+)$/m.exec(frontmatter.body);
  const name = relPath.split("/").pop() ?? relPath;
  return {
    externalId: relPath,
    url: `obsidian://${relPath}`,
    title: heading ? heading[1]!.trim() : name.replace(/\.md$/, ""),
    updatedAt: "", // mtime is not exposed by fs.list — see #112
    body: content,
  };
}

export function createObsidianConnector(): Connector {
  return {
    app: "obsidian",
    scopesHint: ["read: local vault files"],

    async listContainers(p) {
      // The vault root is listed with dir "." — the local provider rejects "".
      const entries = await p.call<Array<{ name: string; type: string }>>("fs.list", { dir: "." });
      return entries
        .filter((e) => e.type === "dir")
        .map((e) => ({ id: e.name, name: e.name }));
    },

    async backfill(p, container, cursor) {
      const entries = await p.call<Array<{ name: string; type: string; mtime?: string }>>("fs.list", { dir: container.id });
      const files = entries
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();
      const start = Number.parseInt(cursor ?? "0", 10);
      const from = Number.isFinite(start) && start > 0 ? start : 0;
      const page = files.slice(from, from + BACKFILL_PAGE);

      const items: ExternalItem[] = [];
      for (const name of page) {
        const relPath = `${container.id}/${name}`;
        const content = await p.call<string>("fs.read", { path: relPath });
        if (isSkippedNote(content)) continue;
        items.push(toExternalItem(relPath, content));
      }
      const next = from + page.length;
      return next < files.length ? { items, nextCursor: String(next) } : { items };
    },

    async poll(p, container, since) {
      const entries = await p.call<Array<{ name: string; type: string; mtime?: string }>>("fs.list", { dir: container.id });
      // mtime filtering needs fs.list to report it — proposed in #112. Until
      // then an entry without an mtime is always included (conservative; the
      // dedupe path drops unchanged content).
      const sinceMs = Date.parse(since);
      const items: ExternalItem[] = [];
      for (const e of entries) {
        if (e.type !== "file" || !e.name.endsWith(".md")) continue;
        if (typeof e.mtime === "string") {
          const mtimeMs = Date.parse(e.mtime);
          if (Number.isFinite(mtimeMs) && Number.isFinite(sinceMs) && mtimeMs <= sinceMs) continue;
        }
        const relPath = `${container.id}/${e.name}`;
        const content = await p.call<string>("fs.read", { path: relPath });
        if (isSkippedNote(content)) continue;
        items.push(toExternalItem(relPath, content));
      }
      return items;
    },

    toSession,
  };
}
