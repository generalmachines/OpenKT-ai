import { describe, expect, it } from "vitest";
import { MAX_BODY_CHARS, TRUNCATION_MARKER, sha256Hex } from "../src/obsidian.js";
import { BACKFILL_PAGE_SIZE, createDriveConnector, driveToSession, INGESTIBLE_MIME_TYPES, MAX_FOLDER_DEPTH } from "../src/gdrive.js";
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

const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const PDF = "application/pdf";

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
        if (all === undefined) throw new Error(`no listing for folder: ${containerId}`);
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

function doc(id: string, modifiedTime = "2026-09-19T12:00:00Z", mimeType = DOC): DriveEntry {
  return { id, name: id, mimeType, modifiedTime, webViewLink: `https://drive.google.com/file/d/${id}` };
}

function folder(id: string): DriveEntry {
  return { id, name: id, mimeType: FOLDER, modifiedTime: "2026-09-19T12:00:00Z", webViewLink: `https://drive.google.com/drive/folders/${id}` };
}

function shortcut(id: string, targetId: string, targetMimeType: string): DriveEntry {
  return {
    id,
    name: `shortcut to ${targetId}`,
    mimeType: SHORTCUT,
    modifiedTime: "2026-09-19T12:00:00Z",
    webViewLink: `https://drive.google.com/drive/shortcuts/${id}`,
    shortcutDetails: { targetId, targetMimeType },
  };
}

function listedFolders(p: { calls: Array<[string, Record<string, unknown>]> }): string[] {
  return p.calls.filter(([a]) => a === "gdrive.listChildren").map(([, q]) => (q as { containerId: string }).containerId);
}

async function allBackfillItems(p: ProviderHandle, containerId: string): Promise<ExternalItem[]> {
  const c = createDriveConnector();
  const all: ExternalItem[] = [];
  let cursor: string | undefined;
  do {
    const r = await c.backfill(p, { id: containerId, name: containerId }, cursor);
    all.push(...r.items);
    if (r.nextCursor === undefined) break;
    cursor = r.nextCursor;
  } while (true);
  return all;
}

describe("createDriveConnector", () => {
  it("listContainers maps the provider's folders", async () => {
    const p = fakeProvider({}, { folder1: [] });
    const c = createDriveConnector();
    expect(await c.listContainers(p)).toEqual([{ id: "folder1", name: "folder1" }]);
  });

  it("backfill collects the whole tree (3 listing pages) and returns every item once", async () => {
    const entries = Array.from({ length: 6 }, (_, i) => doc(`f${i}`));
    const files = Object.fromEntries(entries.map((e) => [e.id, { text: `# n${e.id}` }]));
    const p = fakeProvider(files, { folder1: entries });
    const c = createDriveConnector();
    const r = await c.backfill(p, { id: "folder1", name: "folder1" });
    expect(r.items.map((i) => i.externalId)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5"]);
    expect(r.nextCursor).toBeUndefined();
    // 6 entries at the default page size of 2 → 3 listing calls
    expect(listedFolders(p)).toEqual(["folder1", "folder1", "folder1"]);
    expect(r.items[0]!.updatedAt).toBe("2026-09-19T12:00:00Z");
    expect(typeof r.items[0]!.body).toBe("string");
  });

  it("a tree nested three deep (F → A → B → C, one document in each) returns all four documents (#121)", async () => {
    const listings: Record<string, Listing> = {
      F: [doc("doc-f"), folder("A")],
      A: [doc("doc-a"), folder("B")],
      B: [doc("doc-b"), folder("C")],
      C: [doc("doc-c")],
    };
    const files = Object.fromEntries(
      ["doc-a", "doc-b", "doc-c", "doc-f"].map((id) => [id, { text: `# ${id}` }]),
    );
    const p = fakeProvider(files, listings);
    expect((await allBackfillItems(p, "F")).map((i) => i.externalId)).toEqual(["doc-a", "doc-b", "doc-c", "doc-f"]);
    const p2 = fakeProvider(files, listings);
    const c = createDriveConnector();
    const polled = await c.poll(p2, { id: "F", name: "F" }, "2026-09-19T01:00:00Z");
    expect(polled.map((i) => i.externalId)).toEqual(["doc-a", "doc-b", "doc-c", "doc-f"]);
  });

  it("a document with the same file id in folders A and B is returned once", async () => {
    const listings: Record<string, Listing> = {
      F: [folder("A"), folder("B")],
      A: [doc("shared")],
      B: [doc("shared")],
    };
    const p = fakeProvider({ shared: { text: "# shared" } }, listings);
    const all = await allBackfillItems(p, "F");
    expect(all.map((i) => i.externalId)).toEqual(["shared"]);
  });

  it("a shortcut cycle (C → A) ends: A is listed exactly once, nothing twice", async () => {
    const listings: Record<string, Listing> = {
      F: [folder("A")],
      A: [doc("doc-a"), folder("B")],
      B: [doc("doc-b"), folder("C")],
      C: [doc("doc-c"), shortcut("to-a", "A", FOLDER)],
    };
    const files = Object.fromEntries(
      ["doc-a", "doc-b", "doc-c"].map((id) => [id, { text: `# ${id}` }]),
    );
    const p = fakeProvider(files, listings);
    const all = await allBackfillItems(p, "F");
    expect(all.map((i) => i.externalId)).toEqual(["doc-a", "doc-b", "doc-c"]);
    // F, A, B, C — A was never listed a second time through the shortcut
    expect(listedFolders(p)).toEqual(["F", "A", "B", "C"]);
  });

  it("a chain of 10 nested folders: documents down to depth 8; the folder at depth 9 is never listed", async () => {
    const listings: Record<string, Listing> = {};
    const files: Record<string, { text: string }> = {};
    for (let d = 0; d < 10; d += 1) {
      const id = `d${d}`;
      listings[id] = [doc(`doc-${d}`)];
      files[`doc-${d}`] = { text: `# doc-${d}` };
      if (d < 9) listings[id]!.unshift(folder(`d${d + 1}`));
    }
    const p = fakeProvider(files, listings);
    const c = createDriveConnector();
    const polled = await c.poll(p, { id: "d0", name: "d0" }, "2026-09-19T01:00:00Z");
    expect(polled.map((i) => i.externalId)).toEqual(
      ["doc-0", "doc-1", "doc-2", "doc-3", "doc-4", "doc-5", "doc-6", "doc-7", "doc-8"],
    );
    // d0 (depth 0) … d8 (depth 8) were listed; d9 (depth 9) never
    expect(listedFolders(p)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"]);
  });

  it("a folder deeper than MAX_FOLDER_DEPTH is never listed (the constant is 8)", () => {
    expect(MAX_FOLDER_DEPTH).toBe(8);
    expect(BACKFILL_PAGE_SIZE).toBe(50);
  });

  it("a shortcut to an ingestible document counts as that document; a shortcut to a PDF does not", async () => {
    const listings: Record<string, Listing> = {
      F: [shortcut("to-doc", "real-doc", DOC), shortcut("to-pdf", "real-pdf", PDF)],
    };
    const p = fakeProvider({ "real-doc": { text: "# real" } }, listings);
    const all = await allBackfillItems(p, "F");
    expect(all.map((i) => i.externalId)).toEqual(["real-doc"]); // the target's id, once
    expect(p.calls.some(([, q]) => JSON.stringify(q).includes("real-pdf"))).toBe(false);
  });

  it("backfill pages 120 documents as 50 + 50 + 20", async () => {
    const entries = Array.from({ length: 120 }, (_, i) => doc(`f${String(i).padStart(3, "0")}`));
    const files = Object.fromEntries(entries.map((e) => [e.id, { text: `# ${e.id}` }]));
    // the folder listing itself has 2 pages (100 entries per listing page)
    const p = fakeProvider(files, { folder1: entries }, 100);
    const c = createDriveConnector();
    const page1 = await c.backfill(p, { id: "folder1", name: "folder1" });
    expect(page1.items).toHaveLength(50);
    expect(page1.items[0]!.externalId).toBe("f000");
    expect(page1.nextCursor).toBe("50");
    const page2 = await c.backfill(p, { id: "folder1", name: "folder1" }, page1.nextCursor);
    expect(page2.items).toHaveLength(50);
    expect(page2.items[0]!.externalId).toBe("f050");
    expect(page2.nextCursor).toBe("100");
    const page3 = await c.backfill(p, { id: "folder1", name: "folder1" }, page2.nextCursor);
    expect(page3.items).toHaveLength(20);
    expect(page3.items[0]!.externalId).toBe("f100");
    expect(page3.nextCursor).toBeUndefined();
  });

  it("backfill reads only ingestable mime types; binaries are never read", async () => {
    const p = fakeProvider(
      { doc1: { text: "# doc" }, note1: { text: "plain note" } },
      {
        folder1: [
          doc("doc1", "2026-09-19T12:00:00Z", DOC),
          doc("sheet1", "2026-09-19T12:00:00Z", "application/vnd.google-apps.spreadsheet"),
          doc("pdf1", "2026-09-19T12:00:00Z", PDF),
          doc("note1", "2026-09-19T12:00:00Z", "text/plain"),
        ],
      },
    );
    const c = createDriveConnector();
    const { items } = await c.backfill(p, { id: "folder1", name: "folder1" });
    expect(items.map((i) => i.externalId)).toEqual(["doc1", "note1"]);
    // sheet1 and pdf1 were listed but never read
    expect(p.calls.filter(([a]) => a === "gdrive.readText").map(([, q]) => (q as { fileId: string }).fileId))
      .toEqual(["doc1", "note1"]);
  });

  it("poll reads only documents modified after since, comparing instants; unparseable time count as changed", async () => {
    const p = fakeProvider(
      {
        old1: { text: "# old", modifiedTime: "2026-09-19T04:00:00Z" },
        new1: { text: "# new", modifiedTime: "2026-09-19T08:00:00Z" },
        notime1: { text: "# notime" },
      },
      {
        folder1: [
          doc("old1", "2026-09-19T04:00:00Z"),
          doc("new1", "2026-09-19T08:00:00Z"),
          doc("notime1", "not-a-date"),
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

  it("a null cursor ends a folder's listing: one poll call, backfill returns no nextCursor key (#118)", async () => {
    const p = fakeProvider({ f1: { text: "# f1" } }, { folder1: [doc("f1")] }, 2, null);
    const c = createDriveConnector();
    const items = await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T05:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["f1"]);
    expect(listedFolders(p)).toEqual(["folder1"]);
    const r = await c.backfill(p, { id: "folder1", name: "folder1" });
    expect(r.items.map((i) => i.externalId)).toEqual(["f1"]);
    expect("nextCursor" in r).toBe(false);
  });

  it("poll stops when a buggy provider repeats a folder cursor, and returns the document once (#118)", async () => {
    const p = fakeProvider({ f1: { text: "# f1" } }, { folder1: [doc("f1")] }, 2, "same");
    const c = createDriveConnector();
    const items = await c.poll(p, { id: "folder1", name: "folder1" }, "2026-09-19T05:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["f1"]); // once, not twice
    expect(listedFolders(p)).toEqual(["folder1", "folder1"]); // one follow-up, then the loop stops
  });

  it("toSession on the connector object matches the exported pure function", () => {
    const c = createDriveConnector();
    const it_ = { externalId: "x", url: "u", title: "t", updatedAt: "", body: "# hi\n" };
    expect(c.toSession(it_)).toEqual(driveToSession(it_));
  });
});
