import { describe, expect, it, vi } from "vitest";
import {
  MAX_BODY_CHARS,
  TRUNCATION_MARKER,
  createObsidianConnector,
  frontmatterSpace,
  isSkippedNote,
  noteToTurns,
  parseFrontmatter,
  sha256Hex,
  toSession,
} from "../src/obsidian.js";
import type { ExternalItem, ProviderHandle } from "../src/types.js";

// --- the 6 fixture notes -------------------------------------------------

const NO_HEADINGS = "just some text\nwith two lines\n";

const NESTED_HEADINGS = `# Top

intro text

## Nested A

nested a body

### Deeper

still section one

# Second

second body
`;

const WITH_FRONTMATTER = `---
openkt-space: product-notes
openkt: true
---
# Titled Note

body of the note
`;

const EMPTY = "";

const HUGE = "x".repeat(MAX_BODY_CHARS + 1);

const SKIPPED = `---
openkt: false
---
# Private note

do not ingest
`;

function item(body: string, overrides?: Partial<ExternalItem>): ExternalItem {
  return {
    externalId: "notes/fixture.md",
    url: "obsidian://notes/fixture.md",
    title: "fixture",
    updatedAt: "",
    body,
    ...overrides,
  };
}

// --- toSession: the 6 acceptance fixtures --------------------------------

describe("toSession (6 fixture notes)", () => {
  it("1. no headings → one turn with the whole body", () => {
    const s = toSession(item(NO_HEADINGS));
    expect(s.source).toBe("connector");
    expect(s.client).toBe("obsidian");
    expect(s.external_id).toBe("notes/fixture.md");
    expect(s.external_url).toBe("obsidian://notes/fixture.md");
    expect(s.title).toBe("fixture");
    expect(s.content_hash).toBe(sha256Hex(NO_HEADINGS));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: "just some text\nwith two lines" },
    ]);
  });

  it("2. nested headings → one turn per top-level (#) section, nested stay inside", () => {
    const s = toSession(item(NESTED_HEADINGS));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: "# Top\n\nintro text\n\n## Nested A\n\nnested a body\n\n### Deeper\n\nstill section one" },
      { seq: 2, role: "note", content: "# Second\n\nsecond body" },
    ]);
  });

  it("3. frontmatter is stripped from the turns but hashed with the body", () => {
    const s = toSession(item(WITH_FRONTMATTER, { externalId: "notes/fm.md", url: "obsidian://notes/fm.md", title: "Titled Note" }));
    expect(s.content_hash).toBe(sha256Hex(WITH_FRONTMATTER));
    expect(s.turns).toEqual([
      { seq: 1, role: "note", content: "# Titled Note\n\nbody of the note" },
    ]);
  });

  it("4. an empty note has no turns", () => {
    const s = toSession(item(EMPTY));
    expect(s.turns).toEqual([]);
    expect(s.content_hash).toBe(sha256Hex(""));
  });

  it("5. huge (> 200 KB) → truncated with a marker turn", () => {
    const s = toSession(item(HUGE));
    expect(HUGE.length).toBe(MAX_BODY_CHARS + 1);
    // every turn's content stays within the limit; the last turn is the marker
    const marker = s.turns[s.turns.length - 1]!;
    expect(marker.content).toBe(TRUNCATION_MARKER);
    expect(marker.role).toBe("note");
    expect(marker.seq).toBe(s.turns.length);
    for (const t of s.turns.slice(0, -1)) {
      expect(t.content.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
  });

  it("6. a note with openkt: false is skipped", () => {
    expect(isSkippedNote(SKIPPED)).toBe(true);
    // and the non-skipped fixtures are not
    expect(isSkippedNote(NO_HEADINGS)).toBe(false);
    expect(isSkippedNote(WITH_FRONTMATTER)).toBe(false);
  });
});

// --- helpers -------------------------------------------------------------

describe("frontmatter helpers", () => {
  it("parseFrontmatter reads flat key: value lines and leaves the rest as body", () => {
    const { attrs, body } = parseFrontmatter("---\na: 1\nquoted: \"yes\"\ntitle: Hello\n---\nbody here");
    expect(attrs).toEqual({ a: "1", quoted: "yes", title: "Hello" });
    expect(body).toBe("body here");
  });

  it("text without a closed frontmatter block is the body itself", () => {
    const { attrs, body } = parseFrontmatter("---\nnever closed");
    expect(attrs).toEqual({});
    expect(body).toBe("---\nnever closed");
  });

  it("frontmatterSpace returns openkt-space when set", () => {
    expect(frontmatterSpace(WITH_FRONTMATTER)).toBe("product-notes");
    expect(frontmatterSpace(NO_HEADINGS)).toBeUndefined();
    expect(frontmatterSpace("---\nopenkt-space:\n---\nx")).toBeUndefined();
  });

  it("a malformed frontmatter value line is ignored, not thrown", () => {
    const { attrs, body } = parseFrontmatter("---\nno-colon-line\ngood: yes\n---\nbody");
    expect(attrs).toEqual({ good: "yes" });
    expect(body).toBe("body");
  });
});

describe("noteToTurns", () => {
  it("leading content before the first heading is the first turn", () => {
    const turns = noteToTurns("preamble\n\n# A\n\na body");
    expect(turns).toEqual([
      { seq: 1, role: "note", content: "preamble" },
      { seq: 2, role: "note", content: "# A\n\na body" },
    ]);
  });

  it("an empty heading section is dropped", () => {
    const turns = noteToTurns("# A\n\n\n# B\n\nb body");
    expect(turns).toEqual([
      { seq: 1, role: "note", content: "# A" },
      { seq: 2, role: "note", content: "# B\n\nb body" },
    ]);
  });
});

// --- connector over a fake provider --------------------------------------

function fakeProvider(files: Record<string, string>, listing: Array<{ name: string; type: string; mtime?: string }>): ProviderHandle & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    async call<T>(action: string, params: Record<string, unknown>): Promise<T> {
      calls.push([action, params]);
      if (action === "fs.list") {
        return listing as T;
      }
      if (action === "fs.read") {
        const p = params["path"] as string;
        const content = files[p];
        if (content === undefined) throw new Error(`no such file: ${p}`);
        return content as T;
      }
      throw new Error(`unexpected action: ${action}`);
    },
  };
}

describe("createObsidianConnector", () => {
  it("listContainers lists the vault root with dir '.' and keeps folders only", async () => {
    const p = fakeProvider({}, [
      { name: "Notes", type: "dir" },
      { name: "note.md", type: "file" },
      { name: "Archive", type: "dir" },
    ]);
    const c = createObsidianConnector();
    expect(await c.listContainers(p)).toEqual([
      { id: "Notes", name: "Notes" },
      { id: "Archive", name: "Archive" },
    ]);
    expect(p.calls[0]).toEqual(["fs.list", { dir: "." }]);
  });

  it("backfill reads the .md files of a container, skipping openkt: false", async () => {
    const p = fakeProvider(
      {
        "Notes/a.md": "# A\n\nalpha",
        "Notes/b.txt": "not markdown",
        "Notes/secret.md": "---\nopenkt: false\n---\n# Secret",
        "Notes/c.md": "no headings here",
      },
      [
        { name: "a.md", type: "file" },
        { name: "b.txt", type: "file" },
        { name: "secret.md", type: "file" },
        { name: "c.md", type: "file" },
      ],
    );
    const c = createObsidianConnector();
    const { items, nextCursor } = await c.backfill(p, { id: "Notes", name: "Notes" });
    expect(items.map((i) => i.externalId)).toEqual(["Notes/a.md", "Notes/c.md"]);
    expect(items[0]!.title).toBe("A");
    expect(items[1]!.title).toBe("c");
    expect(nextCursor).toBeUndefined();
    // every .md file is read (the skip needs the content); b.txt is never read
    expect(p.calls.map(([a]) => a)).toEqual(["fs.list", "fs.read", "fs.read", "fs.read"]);
  });

  it("backfill pages: a cursor starts later in the file list", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`Notes/${String(i).padStart(2, "0")}.md`, `# n${i}`]),
    );
    const listing = Array.from({ length: 5 }, (_, i) => ({
      name: `${String(i).padStart(2, "0")}.md`,
      type: "file",
    }));
    const p = fakeProvider(files, listing);
    const c = createObsidianConnector();
    const page1 = await c.backfill(p, { id: "Notes", name: "Notes" });
    expect(page1.items).toHaveLength(5); // 5 files < the 50-file page size
    // force a small second page by crafting a cursor past the first files
    const page2 = await c.backfill(p, { id: "Notes", name: "Notes" }, "3");
    expect(page2.items.map((i) => i.externalId)).toEqual(["Notes/03.md", "Notes/04.md"]);
  });

  it("poll keeps files with no reported mtime or a newer mtime, drops older ones", async () => {
    const p = fakeProvider(
      {
        "Notes/new.md": "# new",
        "Notes/old.md": "# old",
        "Notes/nomtime.md": "# nomtime",
      },
      [
        { name: "new.md", type: "file", mtime: "2026-09-19T12:00:00Z" },
        { name: "old.md", type: "file", mtime: "2026-09-19T10:00:00Z" },
        { name: "nomtime.md", type: "file" },
      ],
    );
    const c = createObsidianConnector();
    const items = await c.poll(p, { id: "Notes", name: "Notes" }, "2026-09-19T11:00:00Z");
    expect(items.map((i) => i.externalId)).toEqual(["Notes/new.md", "Notes/nomtime.md"]);
  });

  it("poll skips openkt: false files", async () => {
    const p = fakeProvider(
      { "Notes/s.md": "---\nopenkt: false\n---\n# s" },
      [{ name: "s.md", type: "file", mtime: "2026-09-19T12:00:00Z" }],
    );
    const c = createObsidianConnector();
    expect(await c.poll(p, { id: "Notes", name: "Notes" }, "2026-09-19T11:00:00Z")).toEqual([]);
  });

  it("toSession on the connector object matches the exported pure function", () => {
    const c = createObsidianConnector();
    const item = { externalId: "x", url: "obsidian://x", title: "t", updatedAt: "", body: "# hi\n" };
    expect(c.toSession(item)).toEqual(toSession(item));
  });
});
