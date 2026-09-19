import { describe, expect, it } from "vitest";
import { MAX_BODY_CHARS, TRUNCATION_MARKER } from "../src/obsidian.js";
import {
  createNotionConnector,
  notionBlocksToMarkdown,
  richTextToPlain,
  sha256Hex,
  toSession,
} from "../src/notion.js";
import type { Block, ExternalItem, ProviderHandle } from "../src/types.js";

// --- fixtures ------------------------------------------------------------

const PLAIN_PAGE: Block[] = [
  { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Overview" }] } },
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "first paragraph" }] } },
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "second paragraph" }] } },
];

const STRUCTURED_PAGE: Block[] = [
  { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Top" }] } },
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "intro" }] } },
  { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Nested" }] } },
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "nested body" }] } },
  { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "one" }] } },
  { type: "to_do", to_do: { rich_text: [{ plain_text: "ship it" }], checked: false } },
  { type: "to_do", to_do: { rich_text: [{ plain_text: "done thing" }], checked: true } },
  { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "step" }] } },
  { type: "quote", quote: { rich_text: [{ plain_text: "wise words" }] } },
  { type: "code", code: { rich_text: [{ plain_text: "const x = 1" }], language: "ts" } },
  { type: "divider", divider: {} },
  { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Second" }] } },
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "closing" }] } },
];

const UNKNOWN_PAGE: Block[] = [
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "keep" }] } },
  { type: "callout", callout: { rich_text: [{ plain_text: "callout text" }] } },
  { type: "paragraph", paragraph: { rich_text: [] } },
];

const HUGE_BLOCKS: Block[] = [
  { type: "paragraph", paragraph: { rich_text: [{ plain_text: "y".repeat(MAX_BODY_CHARS + 1) }] } },
];

const EMPTY_PAGE: Block[] = [];

function item(body: string | Block[], overrides?: Partial<ExternalItem>): ExternalItem {
  return {
    externalId: "page-1",
    url: "https://notion.so/page-1",
    title: "fixture",
    updatedAt: "2026-09-19T12:00:00Z",
    body,
    ...overrides,
  };
}

// --- toSession -----------------------------------------------------------

describe("toSession (pure)", () => {
  it("a heading-less page is one turn", () => {
    const s = toSession(item(PLAIN_PAGE));
    expect(s.source).toBe("connector");
    expect(s.client).toBe("notion");
    expect(s.external_id).toBe("page-1");
    expect(s.external_url).toBe("https://notion.so/page-1");
    expect(s.title).toBe("fixture");
    expect(s.content_hash).toBe(sha256Hex(notionBlocksToMarkdown(PLAIN_PAGE)));
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.content).toContain("# Overview");
    expect(s.turns[0]!.content).toContain("second paragraph");
  });

  it("one turn per top-level section; heading_2 stays inside its section", () => {
    const s = toSession(item(STRUCTURED_PAGE));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: expect.stringContaining("# Top") },
      { seq: 2, role: "note", content: "# Second\n\nclosing" },
    ]);
    expect(s.turns[0]!.content).toContain("## Nested");
    expect(s.turns[0]!.content).toContain("- [ ] ship it");
    expect(s.turns[0]!.content).toContain("- [x] done thing");
    expect(s.turns[0]!.content).toContain("```ts\nconst x = 1\n```");
    expect(s.turns[0]!.content).toContain("> wise words");
    expect(s.turns[0]!.content).toContain("---");
  });

  it("unknown block types keep their plain text; empty ones are dropped", () => {
    const s = toSession(item(UNKNOWN_PAGE));
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.content).toBe("keep\n\ncallout text");
  });

  it("a string body passes through (no frontmatter for Notion)", () => {
    const s = toSession(item("# Title\n\nbody text"));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: "# Title\n\nbody text" },
    ]);
  });

  it("an empty page has no turns", () => {
    const s = toSession(item(EMPTY_PAGE));
    expect(s.turns).toEqual([]);
    expect(s.content_hash).toBe(sha256Hex(""));
  });

  it("items over 200 KB are truncated with a marker turn", () => {
    const s = toSession(item(HUGE_BLOCKS));
    const marker = s.turns[s.turns.length - 1]!;
    expect(marker.content).toBe(TRUNCATION_MARKER);
    expect(marker.role).toBe("note");
    expect(marker.seq).toBe(s.turns.length);
    for (const t of s.turns.slice(0, -1)) {
      expect(t.content.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
    // the hash still covers the original body
    expect(s.content_hash).toBe(sha256Hex(notionBlocksToMarkdown(HUGE_BLOCKS)));
  });

  it("a string body over the limit is truncated too", () => {
    const huge = "z".repeat(MAX_BODY_CHARS + 5);
    const s = toSession(item(huge));
    expect(s.turns[s.turns.length - 1]!.content).toBe(TRUNCATION_MARKER);
    for (const t of s.turns.slice(0, -1)) {
      expect(t.content.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
  });
});

// --- helpers -------------------------------------------------------------

describe("block helpers", () => {
  it("richTextToPlain concatenates plain_text", () => {
    expect(richTextToPlain([{ plain_text: "a" }, { plain_text: "b" }, {}])).toBe("ab");
    expect(richTextToPlain("not an array")).toBe("");
  });

  it("notionBlocksToMarkdown handles an empty list", () => {
    expect(notionBlocksToMarkdown([])).toBe("");
  });
});

// --- connector over a fake provider --------------------------------------

type Listing = Array<{ id: string; title: string; lastEditedTime: string; url: string }>;

function fakeProvider(pages: Record<string, { blocks: Block[]; lastEditedTime?: string }>, listings: Record<string, Listing>): ProviderHandle & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    async call<T>(action: string, params: Record<string, unknown>): Promise<T> {
      calls.push([action, params]);
      if (action === "notion.listContainers") {
        return Object.keys(listings).map((id) => ({ id, name: id })) as T;
      }
      if (action === "notion.listChildren") {
        const containerId = params["containerId"] as string;
        const cursor = params["cursor"] as string | undefined;
        const all = listings[containerId];
        if (all === undefined) throw new Error(`no listing for container: ${containerId}`);
        // three pages of two entries, driven by the cursor
        const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
        const page = all.slice(start, start + 2);
        const next = start + 2 < all.length ? String(start + 2) : undefined;
        return { entries: page, nextCursor: next } as T;
      }
      if (action === "notion.readPage") {
        const pageId = params["pageId"] as string;
        const page = pages[pageId];
        if (page === undefined) throw new Error(`no such page: ${pageId}`);
        return {
          title: pageId,
          lastEditedTime: page.lastEditedTime ?? "2026-09-19T12:00:00Z",
          url: `https://notion.so/${pageId}`,
          blocks: page.blocks,
        } as T;
      }
      throw new Error(`unexpected action: ${action}`);
    },
  };
}


describe("createNotionConnector", () => {
  it("listContainers maps the provider's containers", async () => {
    const p = fakeProvider({}, { ts1: [] });
    const c = createNotionConnector();
    expect(await c.listContainers(p)).toEqual([{ id: "ts1", name: "ts1" }]);
  });

  it("backfill pages through a fake provider with 3 pages and returns every item once", async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      title: `Page ${i}`,
      lastEditedTime: "2026-09-19T12:00:00Z",
      url: `https://notion.so/p${i}`,
    }));
    const pages = Object.fromEntries(
      entries.map((e) => [e.id, { blocks: PLAIN_PAGE, lastEditedTime: e.lastEditedTime }]),
    );
    const p = fakeProvider(pages, { ts1: entries });
    const c = createNotionConnector();
    const all: ExternalItem[] = [];
    let cursor: string | undefined;
    let pagesOfCalls = 0;
    for (;;) {
      const r = await c.backfill(p, { id: "ts1", name: "ts1" }, cursor);
      pagesOfCalls += 1;
      all.push(...r.items);
      if (r.nextCursor === undefined) break;
      cursor = r.nextCursor;
    }
    expect(pagesOfCalls).toBe(3);
    expect(all.map((i) => i.externalId)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(new Set(all.map((i) => i.externalId)).size).toBe(6); // every item once
    expect(all[0]!.title).toBe("Page 0");
    expect(all[0]!.updatedAt).toBe("2026-09-19T12:00:00Z");
    expect(typeof all[0]!.body).toBe("object"); // Notion blocks, flattened in toSession
  });

  it("poll reads only pages edited after since", async () => {
    const listings = {
      ts1: [
        { id: "old", title: "Old", lastEditedTime: "2026-09-19T04:00:00Z", url: "https://notion.so/old" },
        { id: "new", title: "New", lastEditedTime: "2026-09-19T08:00:00Z", url: "https://notion.so/new" },
      ],
    };
    const pages = {
      old: { blocks: PLAIN_PAGE, lastEditedTime: "2026-09-19T04:00:00Z" },
      new: { blocks: PLAIN_PAGE, lastEditedTime: "2026-09-19T08:00:00Z" },
    };
    const p = fakeProvider(pages, listings);
    const c = createNotionConnector();
    const items = await c.poll(p, { id: "ts1", name: "ts1" }, "2026-09-19T06:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["new"]);
    // an offset `since` compares as an instant
    const items2 = await c.poll(p, { id: "ts1", name: "ts1" }, "2026-09-19T13:00:00+07:00"); // = 06:00Z
    expect(items2.map((i) => i.externalId)).toEqual(["new"]);
  });

  it("poll without a usable since returns everything", async () => {
    const listings = {
      ts1: [{ id: "p", title: "P", lastEditedTime: "2026-09-19T08:00:00Z", url: "u" }],
    };
    const p = fakeProvider({ p: { blocks: PLAIN_PAGE } }, listings);
    const c = createNotionConnector();
    const items = await c.poll(p, { id: "ts1", name: "ts1" }, "not-a-date");
    expect(items.map((i) => i.externalId)).toEqual(["p"]);
  });
});
