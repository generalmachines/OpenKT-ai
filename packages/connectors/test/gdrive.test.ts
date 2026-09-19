import { describe, expect, it } from "vitest";
import { MAX_BODY_CHARS, TRUNCATION_MARKER, sha256Hex } from "../src/obsidian.js";
import { createDriveConnector, driveToSession, INGESTIBLE_MIME_TYPES } from "../src/gdrive.js";
import type { DriveEntry } from "../src/gdrive.js";
import type { ExternalItem, ProviderHandle } from "../src/types.js";

// --- fixtures ------------------------------------------------------------

const PLAIN_TEXT = "just some text\nwith two lines\n";

const HEADED_TEXT = `# Top

top body

# Second

second body
`;

const EMPTY_TEXT = "";

const HUGE_TEXT = "z".repeat(MAX_BODY_CHARS + 1);

// --- driveToSession (pure) ------------------------------------------------

function item(body: string, overrides?: Partial<ExternalItem>): ExternalItem {
  return {
    externalId: "file-1",
    url: "https://drive.google.com/file/d/file-1",
    title: "fixture",
    updatedAt: "2026-09-19T12:00:00Z",
    body,
    ...overrides,
  };
}

describe("driveToSession (pure)", () => {
  it("plain text → one turn with the whole body", () => {
    const s = driveToSession(item(PLAIN_TEXT));
    expect(s.source).toBe("connector");
    expect(s.client).toBe("gdrive");
    expect(s.external_id).toBe("file-1");
    expect(s.external_url).toBe("https://drive.google.com/file/d/file-1");
    expect(s.title).toBe("fixture");
    expect(s.content_hash).toBe(sha256Hex(PLAIN_TEXT));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: "just some text\nwith two lines" },
    ]);
  });

  it("top-level headings → one turn per section", () => {
    const s = driveToSession(item(HEADED_TEXT));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: "# Top\n\ntop body" },
      { seq: 2, role: "note", content: "# Second\n\nsecond body" },
    ]);
  });

  it("an empty document has no turns", () => {
    const s = driveToSession(item(EMPTY_TEXT));
    expect(s.turns).toEqual([]);
    expect(s.content_hash).toBe(sha256Hex(""));
  });

  it("huge (> 200 KB) → truncated with a marker turn", () => {
    const s = driveToSession(item(HUGE_TEXT));
    expect(HUGE_TEXT.length).toBe(MAX_BODY_CHARS + 1);
    const marker = s.turns[s.turns.length - 1]!;
    expect(marker.content).toBe(TRUNCATION_MARKER);
    expect(marker.role).toBe("note");
    expect(marker.seq).toBe(s.turns.length);
    for (const t of s.turns.slice(0, -1)) {
      expect(t.content.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
  });

  it("turns are built from the truncated text, but the hash covers the original", () => {
    const s = driveToSession(item(HUGE_TEXT));
    expect(s.content_hash).toBe(sha256Hex(HUGE_TEXT));
    const body = s.turns[s.turns.length - 2]!.content;
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });
});

describe("INGESTIBLE_MIME_TYPES", () => {
  it("text documents are ingested, binaries are not", () => {
    expect(INGESTIBLE_MIME_TYPES.has("text/markdown")).toBe(true);
    expect(INGESTIBLE_MIME_TYPES.has("text/plain")).toBe(true);
    expect(INGESTIBLE_MIME_TYPES.has("application/vnd.google-apps.document")).toBe(true);
    expect(INGESTIBLE_MIME_TYPES.has("application/vnd.google-apps.spreadsheet")).toBe(false);
    expect(INGESTIBLE_MIME_TYPES.has("application/pdf")).toBe(false);
    expect(INGESTIBLE_MIME_TYPES.has("image/png")).toBe(false);
  });
});

// --- connector over a fake provider --------------------------------------

type Listing = DriveEntry[];

function fakeProvider(files: Record<string, { text: string; modifiedTime?: string }>, listings: Record<string, Listing>, pageSize = 2, fixedNextCursor?: string | null): ProviderHandle & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    async call<T>(action: string, params: Record<string, unknown>): Promise<T> {
      calls.push([action, params]);
      if (action === "gdrive.listContainers") {
        return Object.keys(listings).map((id) => ({ id, name: id })) as T;
      }
      if (action === "gdrive.listChildren") {
        const containerId = params["containerId"] as string;
        const cursor = params["cursor"] as string | undefined;
        const all = listings[containerId];
        if (all === undefined) throw new Error(`no listing for container: ${containerId}`);
        // pages of `pageSize` entries, driven by the cursor
        const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
        const page = all.slice(start, start + pageSize);
        const next = fixedNextCursor !== undefined
          ? fixedNextCursor
          : start + pageSize < all.length ? String(start + pageSize) : undefined;
        return { entries: page, nextCursor: next } as T;
      }
      if (action === "gdrive.readText") {
        const fileId = params["fileId"] as string;
        const file = files[fileId];
        if (file === undefined) throw new Error(`no such file: ${fileId}`);
        return {
          title: fileId,
          modifiedTime: file.modifiedTime ?? "2026-09-19T12:00:00Z",
          webViewLink: `https://drive.google.com/file/d/${fileId}`,
          text: file.text,
        } as T;
      }
      throw new Error(`unexpected action: ${action}`);
    },
  };
}

function entry(id: string, mimeType: string, modifiedTime: string): DriveEntry {
  return { id, name: id, mimeType, modifiedTime, webViewLink: `https://drive.google.com/file/d/${id}` };
}

const DOC = "application/vnd.google-apps.document";

describe("createDriveConnector", () => {
  it("listContainers maps the provider's folders", async () => {
    const p = fakeProvider({}, { folder1: [] });
    const c = createDriveConnector();
    expect(await c.listContainers(p)).toEqual([{ id: "folder1", name: "folder1" }]);
  });

  it("backfill pages through a fake provider with 3 pages and returns every item once", async () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`f${i}`, DOC, "2026-09-19T12:00:00Z"));
    const files = Object.fromEntries(entries.map((e) => [e.id, { text: `# n${e.id}`, modifiedTime: e.modifiedTime }]));
    const p = fakeProvider(files, { folder1: entries });
    const c = createDriveConnector();
    const all: ExternalItem[] = [];
    let cursor: string | undefined;
    let pagesOfCalls = 0;
    for (;;) {
      const r = await c.backfill(p, { id: "folder1", name: "folder1" }, cursor);
      pagesOfCalls += 1;
      all.push(...r.items);
      if (r.nextCursor === undefined) break;
      cursor = r.nextCursor;
    }
    expect(pagesOfCalls).toBe(3);
    expect(all.map((i) => i.externalId)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5"]);
    expect(new Set(all.map((i) => i.externalId)).size).toBe(6); // every item once
    expect(all[0]!.title).toBe("f0");
    expect(all[0]!.updatedAt).toBe("2026-09-19T12:00:00Z");
    expect(typeof all[0]!.body).toBe("string");
  });

  it("backfill reads only ingestable mime types; binaries are never read", async () => {
    const p = fakeProvider(
      { doc1: { text: "# doc" }, note1: { text: "plain note" } },
      {
        folder1: [
          entry("doc1", DOC, "2026-09-19T12:00:00Z"),
          entry("sheet1", "application/vnd.google-apps.spreadsheet", "2026-09-19T12:00:00Z"),
          entry("pdf1", "application/pdf", "2026-09-19T12:00:00Z"),
          entry("note1", "text/plain", "2026-09-19T12:00:00Z"),
        ],
      },
    );
    const c = createDriveConnector();
    const all: ExternalItem[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await c.backfill(p, { id: "folder1", name: "folder1" }, cursor);
      all.push(...r.items);
      if (r.nextCursor === undefined) break;
      cursor = r.nextCursor;
    }
    expect(all.map((i) => i.externalId)).toEqual(["doc1", "note1"]);
    // sheet1 and pdf1 were listed but never read
    expect(p.calls.filter(([a]) => a === "gdrive.readText").map(([, q]) => (q as { fileId: string }).fileId))
      .toEqual(["doc1", "note1"]);
  });

  it("poll reads only documents modified after since, comparing instants", async () => {
    const p = fakeProvider(
      {
        old1: { text: "# old", modifiedTime: "2026-09-19T04:00:00Z" },
        new1: { text: "# new", modifiedTime: "2026-09-19T08:00:00Z" },
        notime1: { text: "# notime" },
      },
      {
        folder1: [
          entry("old1", DOC, "2026-09-19T04:00:00Z"),
          entry("new1", DOC, "2026-09-19T08:00:00Z"),
          entry("notime1", DOC, "not-a-date"),
        ],
      },
    );
    const c = createDriveConnector();
    const items = await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T06:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["new1", "notime1"]);
    // an offset `since` compares as an instant
    const items2 = await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T13:00:00+07:00"); // = 06:00Z
    expect(items2.map((i) => i.externalId)).toEqual(["new1", "notime1"]);
  });

  it("poll skips non-ingestable mime types", async () => {
    const p = fakeProvider(
      { sheet1: { text: "nope" } },
      { folder1: [entry("sheet1", "application/vnd.google-apps.spreadsheet", "2026-09-19T09:00:00Z")] },
    );
    const c = createDriveConnector();
    expect(await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T05:00:00Z")).toEqual([]);
    expect(p.calls.some(([a]) => a === "gdrive.readText")).toBe(false);
  });

  it("a null cursor ends the listing: one poll call, backfill returns no nextCursor key (#118)", async () => {
    const p = fakeProvider(
      { f1: { text: "# f1" } },
      { folder1: [entry("f1", DOC, "2026-09-19T09:00:00Z")] },
      2,
      null,
    );
    const c = createDriveConnector();
    const items = await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T05:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["f1"]);
    expect(p.calls.filter(([a]) => a === "gdrive.listChildren")).toHaveLength(1);
    const r = await c.backfill(p, { id: "folder1", name: "folder1" });
    expect(r.items.map((i) => i.externalId)).toEqual(["f1"]);
    expect("nextCursor" in r).toBe(false);
  });

  it("poll stops when a buggy provider repeats a cursor, and returns the entry once (#118)", async () => {
    const p = fakeProvider(
      { f1: { text: "# f1" } },
      { folder1: [entry("f1", DOC, "2026-09-19T09:00:00Z")] },
      2,
      "same",
    );
    const c = createDriveConnector();
    const items = await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T05:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["f1"]); // once, not twice
    expect(p.calls.filter(([a]) => a === "gdrive.listChildren")).toHaveLength(2);
  });

  it("toSession on the connector object matches the exported pure function", () => {
    const c = createDriveConnector();
    const it_ = { externalId: "x", url: "u", title: "t", updatedAt: "", body: "# hi\n" };
    expect(c.toSession(it_)).toEqual(driveToSession(it_));
  });
});
