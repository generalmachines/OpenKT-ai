// Notion connector (Spec 05 §3–§4): one container = one teamspace, each page
// is one session. Everything goes through the ProviderHandle — the connector
// never calls the Notion API itself. The provider's action contract:
//
//   notion.listContainers {}                    → Array<{ id, name }>
//   notion.listChildren { containerId, cursor? } → { entries: [{ id, title, lastEditedTime, url }], nextCursor? }
//   notion.readPage { pageId }                  → { title, lastEditedTime, url, blocks }
//       `blocks` carry `children: Block[]` filled in for `has_children`
//       blocks, so nested bullets/toggles/paragraphs arrive inline.
//
// Rich block content is flattened to markdown with the product's own
// block-to-markdown helper (Spec 05 §4); turn rules and truncation follow
// the same helpers as the Obsidian connector.

import {
  MAX_BODY_CHARS,
  TRUNCATION_MARKER,
  noteToTurns,
  sha256Hex,
} from "./obsidian.js";
import type { Block, Connector, ExternalItem, SessionDraft } from "./types.js";

export interface NotionEntry {
  id: string;
  title: string;
  lastEditedTime: string; // ISO-8601
  url: string;
}

export interface NotionPage {
  title: string;
  lastEditedTime: string;
  url: string;
  blocks: Block[];
}

interface ListingEntry {
  id: string;
  title: string;
  lastEditedTime: string;
  url: string;
}

/** Concatenate a Notion `rich_text` array to plain text. */
export function richTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((rt) => {
      const plain = (rt as { plain_text?: unknown }).plain_text;
      return typeof plain === "string" ? plain : "";
    })
    .join("");
}

function renderBlock(block: unknown, indent: string): string[] {
  const b = (block ?? {}) as Record<string, unknown>;
  const type = typeof b["type"] === "string" ? b["type"] : "";
  const inner = (b[type] ?? {}) as Record<string, unknown>;
  const text = richTextToPlain(inner["rich_text"]).trim();
  const lines: string[] = [];
  switch (type) {
    case "heading_1":
      lines.push(`${indent}# ${text}`, "");
      break;
    case "heading_2":
      lines.push(`${indent}## ${text}`, "");
      break;
    case "heading_3":
      lines.push(`${indent}### ${text}`, "");
      break;
    case "paragraph":
      lines.push(`${indent}${text}`, "");
      break;
    case "bulleted_list_item":
      lines.push(`${indent}- ${text}`);
      break;
    case "numbered_list_item":
      lines.push(`${indent}1. ${text}`);
      break;
    case "to_do":
      lines.push(`${indent}${inner["checked"] === true ? "- [x] " : "- [ ] "}${text}`);
      break;
    case "quote":
      lines.push(`${indent}> ${text}`, "");
      break;
    case "code": {
      const lang = typeof inner["language"] === "string" ? inner["language"] : "";
      lines.push(`${indent}\`\`\`${lang}`, `${indent}${text}`, `${indent}\`\`\``, "");
      break;
    }
    case "divider":
      lines.push(`${indent}---`, "");
      break;
    default:
      if (text !== "") lines.push(`${indent}${text}`, "");
  }
  // Nested content lives in the block's children — flattened into the
  // parent's turn, indented two spaces, never dropped.
  const children = b["children"];
  if (Array.isArray(children)) {
    for (const child of children) {
      lines.push(...renderBlock(child, `${indent}  `));
    }
  }
  return lines;
}

/**
 * The product's own block-to-markdown helper (Spec 05 §4): Notion blocks are
 * structured JSON, not HTML, so `turndown` has nothing to convert here.
 * Recognised block types become their markdown form; unknown types keep
 * their plain text.
 */
export function notionBlocksToMarkdown(blocks: Block[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(...renderBlock(block, ""));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

/**
 * `notionToSession` per Spec 05 §3, pure: one turn per top-level section
 * (`# …`), role `'note'`; `content_hash` = sha256 of the markdown body;
 * items over 200 KB are truncated with a marker turn (Spec 05 §4).
 * Named `notionToSession` because `index.ts` re-exports both connectors'
 * helpers and each product's `toSession` must keep a distinct name.
 */
export function notionToSession(item: ExternalItem): SessionDraft {
  const md = typeof item.body === "string" ? item.body : notionBlocksToMarkdown(item.body);
  // The hash covers the original body; the turns are built from the
  // truncated text (Spec 05 §4: over 200 KB → truncated with a marker turn).
  const turns = noteToTurns(md.length > MAX_BODY_CHARS ? md.slice(0, MAX_BODY_CHARS) : md);
  if (md.length > MAX_BODY_CHARS) {
    turns.push({ seq: turns.length + 1, role: "note", content: TRUNCATION_MARKER });
  }
  return {
    source: "connector",
    client: "notion",
    external_id: item.externalId,
    external_url: item.url,
    title: item.title,
    content_hash: sha256Hex(md),
    turns,
  };
}

/**
 * Notion's API returns `next_cursor: null` on the last page, so a provider
 * may pass `nextCursor: null` through — treated like an absent cursor
 * everywhere (a `null` cursor would otherwise loop a poll job forever).
 */
function normalizeCursor(value: string | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function toExternalItem(entry: ListingEntry, blocks: Block[]): ExternalItem {
  return {
    externalId: entry.id,
    url: entry.url,
    title: entry.title,
    updatedAt: entry.lastEditedTime,
    body: blocks,
  };
}

export function createNotionConnector(): Connector {
  return {
    app: "notion",
    scopesHint: ["read: selected Notion teamspaces"],

    async listContainers(p) {
      const containers = await p.call<Array<{ id: string; name: string }>>("notion.listContainers", {});
      return containers.map((c) => ({ id: c.id, name: c.name }));
    },

    async backfill(p, container, cursor) {
      // The outer cursor IS the provider's pagination cursor: one backfill
      // call reads one `listChildren` page, and the app follows `nextCursor`.
      const page = await p.call<{ entries: ListingEntry[]; nextCursor?: string }>("notion.listChildren", {
        containerId: container.id,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const items: ExternalItem[] = [];
      for (const entry of page.entries) {
        const content = await p.call<NotionPage>("notion.readPage", { pageId: entry.id });
        items.push(toExternalItem(entry, content.blocks));
      }
      const next = normalizeCursor(page.nextCursor);
      return next !== undefined ? { items, nextCursor: next } : { items };
    },

    async poll(p, container, since) {
      // Page through the listing until it is exhausted, then read what
      // changed — `listChildren` is paginated per the contract above. A
      // repeated cursor stops the loop, so a buggy provider cannot spin
      // the poll job forever.
      const entries: ListingEntry[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const page = await p.call<{ entries: ListingEntry[]; nextCursor?: string }>("notion.listChildren", {
          containerId: container.id,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        entries.push(...page.entries);
        const next = normalizeCursor(page.nextCursor);
        if (next === undefined || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
      const sinceMs = Date.parse(since);
      const items: ExternalItem[] = [];
      for (const entry of entries) {
        const editedMs = Date.parse(entry.lastEditedTime);
        if (Number.isFinite(editedMs) && Number.isFinite(sinceMs) && editedMs <= sinceMs) continue;
        const content = await p.call<NotionPage>("notion.readPage", { pageId: entry.id });
        items.push(toExternalItem(entry, content.blocks));
      }
      return items;
    },

    toSession: notionToSession,
  };
}
