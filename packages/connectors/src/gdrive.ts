// Google Drive connector (Spec 05 §3–§4): one container = one Drive folder,
// each text document is one session. Everything goes through the
// ProviderHandle — the connector never calls the Drive API itself. The
// provider's action contract:
//
//   gdrive.listContainers {}                     → Array<{ id, name }>
//   gdrive.listChildren { containerId, cursor? } → { entries: [{ id, name, mimeType, modifiedTime, webViewLink, shortcutDetails? }], nextCursor? }
//       Lists the DIRECT children of one folder, paginated; a `null`/`""`
//       cursor ends the listing. An entry is a document, a folder
//       (`mimeType: 'application/vnd.google-apps.folder'`), or a shortcut
//       (`mimeType: 'application/vnd.google-apps.shortcut'` with
//       `shortcutDetails: { targetId, targetMimeType }`, as the Drive API
//       names them). The connector walks the folder tree itself — provider
//       list actions return direct children only (#121, J73b).
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
import type { Connector, ExternalItem, ProviderHandle, SessionDraft } from "./types.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** Subfolders deeper than this are never listed (#121, J73b). */
export const MAX_FOLDER_DEPTH = 8;

/** `backfill` returns this many documents per call, `nextCursor` = offset (Obsidian pattern). */
export const BACKFILL_PAGE_SIZE = 50;

export interface DriveShortcutDetails {
  targetId: string;
  targetMimeType: string;
}

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string; // ISO-8601
  webViewLink: string;
  shortcutDetails?: DriveShortcutDetails;
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
 * forever). Private copy: the shared-helpers home (`obsidian.ts`) is out of
 * scope for J73b (Issue #121).
 */
function normalizeCursor(value: string | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Walk the container's folder tree (depth 0 = the container) and return
 * every ingestible document, de-duplicated by file id and sorted by id:
 *
 * - A folder, or a shortcut whose `targetMimeType` is a folder (via
 *   `targetId`), is descended into only while its depth is ≤
 *   `MAX_FOLDER_DEPTH`; a folder at depth 9 is never listed.
 * - The visited-folder `Set` starts with the container, so shared folders
 *   and shortcut cycles are listed exactly once.
 * - A shortcut to an ingestible document counts as that document
 *   (`id = targetId`).
 * - Every folder's listing follows its cursors with the `normalizeCursor`
 *   and repeated-cursor rules, so a buggy provider cannot spin the walk.
 */
async function listTreeDocuments(p: ProviderHandle, containerId: string): Promise<DriveEntry[]> {
  const documents = new Map<string, DriveEntry>();
  const visitedFolders = new Set<string>([containerId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: containerId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await p.call<{ entries: DriveEntry[]; nextCursor?: string }>("gdrive.listChildren", {
        containerId: id,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const entry of page.entries) {
        const folderId = entry.mimeType === FOLDER_MIME
          ? entry.id
          : entry.mimeType === SHORTCUT_MIME && entry.shortcutDetails?.targetMimeType === FOLDER_MIME
            ? entry.shortcutDetails.targetId
            : undefined;
        if (folderId !== undefined) {
          if (depth + 1 <= MAX_FOLDER_DEPTH && !visitedFolders.has(folderId)) {
            visitedFolders.add(folderId);
            queue.push({ id: folderId, depth: depth + 1 });
          }
          continue;
        }
        const docMimeType = entry.mimeType === SHORTCUT_MIME
          ? entry.shortcutDetails?.targetMimeType
          : entry.mimeType;
        const docId = entry.mimeType === SHORTCUT_MIME ? entry.shortcutDetails?.targetId : entry.id;
        if (docMimeType === undefined || docId === undefined || !INGESTIBLE_MIME_TYPES.has(docMimeType)) continue;
        if (!documents.has(docId)) {
          documents.set(docId, { ...entry, id: docId, mimeType: docMimeType });
        }
      }
      const next = normalizeCursor(page.nextCursor);
      if (next === undefined || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
  }
  return [...documents.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

export function createDriveConnector(): Connector {
  return {
    app: "gdrive",
    scopesHint: ["read: selected Google Drive folders"],

    async listContainers(p) {
      const folders = await p.call<Array<{ id: string; name: string }>>("gdrive.listContainers", {});
      return folders.map((f) => ({ id: f.id, name: f.name }));
    },

    async backfill(p, container, cursor) {
      // Walk the whole tree, then page the de-duplicated documents 50 at a
      // time — `nextCursor` is the offset string (the Obsidian pattern).
      const documents = await listTreeDocuments(p, container.id);
      const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const offset = Number.isFinite(start) ? start : 0;
      const page = documents.slice(offset, offset + BACKFILL_PAGE_SIZE);
      const items: ExternalItem[] = [];
      for (const entry of page) {
        const content = await p.call<DriveText>("gdrive.readText", { fileId: entry.id });
        items.push(toExternalItem(entry, content.text));
      }
      const next = offset + BACKFILL_PAGE_SIZE < documents.length ? String(offset + BACKFILL_PAGE_SIZE) : undefined;
      return next !== undefined ? { items, nextCursor: next } : { items };
    },

    async poll(p, container, since) {
      // Walk the whole tree, then read the documents modified after `since`.
      // A missing or unparseable modifiedTime counts as changed.
      const documents = await listTreeDocuments(p, container.id);
      const sinceMs = Date.parse(since);
      const items: ExternalItem[] = [];
      for (const entry of documents) {
        const modifiedMs = Date.parse(entry.modifiedTime);
        if (Number.isFinite(modifiedMs) && Number.isFinite(sinceMs) && modifiedMs <= sinceMs) continue;
        const content = await p.call<DriveText>("gdrive.readText", { fileId: entry.id });
        items.push(toExternalItem(entry, content.text));
      }
      return items;
    },

    toSession: driveToSession,
  };
}
