// Google Drive connector (Spec 05 §3–§4): one container = one Drive folder,
// each text document is one session. Everything goes through the
// ProviderHandle — the connector never calls the Drive API itself. The
// provider's action contract:
//
//   gdrive.listContainers {}                     → Array<{ id, name }>
//   gdrive.listChildren { containerId, cursor? } → { entries: [{ id, name, mimeType, modifiedTime, webViewLink }], nextCursor? }
//       Lists every document under the container, subfolders included
//       (recursively — the provider walks the folder tree), paginated with
//       `nextCursor`; a `null`/`""` cursor ends the listing.
//   gdrive.readText { fileId }                   → { title, modifiedTime, webViewLink, text }
//       `text` is markdown-ready plain text (the provider exports Google
//       Docs); binary formats are never read — the connector only ingests
//       the text mime types below (Spec 05 §4: binary documents are out of
//       scope until a file-parsing provider exists).
//
// Documents flatten to markdown with the shared turn helpers (Spec 05 §4);
// a document becomes one turn per top-level section.

import {
  MAX_BODY_CHARS,
  TRUNCATION_MARKER,
  noteToTurns,
  sha256Hex,
} from "./obsidian.js";
import type { Connector, ExternalItem, SessionDraft } from "./types.js";

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string; // ISO-8601
  webViewLink: string;
}

export interface DriveText {
  title: string;
  modifiedTime: string; // ISO-8601
  webViewLink: string;
  text: string;
}

/** The only mime types ingested; everything else (sheets, PDFs, images) is skipped. */
export const INGESTIBLE_MIME_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "application/vnd.google-apps.document",
]);

/**
 * Drive's API returns `nextPageToken` as `null`-ish on the last page, so a
 * provider may pass `nextCursor: null` through — treated like an absent
 * cursor everywhere (a `null` cursor would otherwise loop a poll job
 * forever).
 */
function normalizeCursor(value: string | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `driveToSession` per Spec 05 §4: a document → one turn per top-level
 * section (`# …`), role `'note'`; `content_hash` = sha256 of the text;
 * items over 200 KB are truncated with a marker turn.
 * Named `driveToSession` because `index.ts` re-exports every connector's
 * helpers and each product's `toSession` must keep a distinct name.
 */
export function driveToSession(item: ExternalItem): SessionDraft {
  const md = typeof item.body === "string" ? item.body : "";
  // The hash covers the original body; the turns are built from the
  // truncated text (Spec 05 §4: over 200 KB → truncated with a marker turn).
  const turns = noteToTurns(md.length > MAX_BODY_CHARS ? md.slice(0, MAX_BODY_CHARS) : md);
  if (md.length > MAX_BODY_CHARS) {
    turns.push({ seq: turns.length + 1, role: "note", content: TRUNCATION_MARKER });
  }
  return {
    source: "connector",
    client: "gdrive",
    external_id: item.externalId,
    external_url: item.url,
    title: item.title,
    content_hash: sha256Hex(md),
    turns,
  };
}

function toExternalItem(entry: DriveEntry, text: string): ExternalItem {
  return {
    externalId: entry.id,
    url: entry.webViewLink,
    title: entry.name,
    updatedAt: entry.modifiedTime,
    body: text,
  };
}

function isIngestible(entry: DriveEntry): boolean {
  return INGESTIBLE_MIME_TYPES.has(entry.mimeType);
}

export function createDriveConnector(): Connector {
  return {
    app: "gdrive",
    scopesHint: ["read: selected Google Drive folders"],

    async listContainers(p) {
      const folders = await p.call<Array<{ id: string; name: string }>>("gdrive.listContainers", {});
      return folders.map((f) => ({ id: f.id, name: f.name }));
    },

    async backfill(p, container, cursor) {
      // The outer cursor IS the provider's pagination cursor: one backfill
      // call reads one `listChildren` page, and the app follows `nextCursor`.
      const page = await p.call<{ entries: DriveEntry[]; nextCursor?: string }>("gdrive.listChildren", {
        containerId: container.id,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const items: ExternalItem[] = [];
      for (const entry of page.entries) {
        if (!isIngestible(entry)) continue;
        const content = await p.call<DriveText>("gdrive.readText", { fileId: entry.id });
        items.push(toExternalItem(entry, content.text));
      }
      const next = normalizeCursor(page.nextCursor);
      return next !== undefined ? { items, nextCursor: next } : { items };
    },

    async poll(p, container, since) {
      // Page through the listing until it is exhausted (a repeated cursor
      // stops the loop, so a buggy provider cannot spin), de-duplicated by
      // id, then read what changed. Entries without a usable modifiedTime
      // are treated as changed.
      const entries: DriveEntry[] = [];
      const seenIds = new Set<string>();
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const page = await p.call<{ entries: DriveEntry[]; nextCursor?: string }>("gdrive.listChildren", {
          containerId: container.id,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const entry of page.entries) {
          if (seenIds.has(entry.id)) continue;
          seenIds.add(entry.id);
          entries.push(entry);
        }
        const next = normalizeCursor(page.nextCursor);
        if (next === undefined || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
      const sinceMs = Date.parse(since);
      const items: ExternalItem[] = [];
      for (const entry of entries) {
        const modifiedMs = Date.parse(entry.modifiedTime);
        if (Number.isFinite(modifiedMs) && Number.isFinite(sinceMs) && modifiedMs <= sinceMs) continue;
        if (!isIngestible(entry)) continue;
        const content = await p.call<DriveText>("gdrive.readText", { fileId: entry.id });
        items.push(toExternalItem(entry, content.text));
      }
      return items;
    },

    toSession: driveToSession,
  };
}
