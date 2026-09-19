import {
  NOTHING_RELEVANT,
  briefMarkdown,
  recallLine,
  recallText,
  savedText,
  spacesText,
  toRecallItem,
} from "../../apps/server/src/modules/mcp/services/mcp-text";

const memory = {
  id: "11111111-1111-4111-8111-111111111111",
  org_id: null,
  project_id: "22222222-2222-4222-8222-222222222222",
  owner: { user_id: "33333333-3333-4333-8333-333333333333", email: "ana@example.test", display_name: "Ana" },
  content: "We chose Postgres\n over a graph database.",
  kind: "decision" as const,
  category: null,
  tags: [{ id: "44444444-4444-4444-8444-444444444444", slug: "storage", display_name: "Storage" }],
  visibility: "project" as const,
  confidence: 1,
  importance: 0.5,
  decay_lambda: 0.01,
  importance_at: "2026-09-19T10:00:00.000Z",
  importance_now: 0.5,
  decay_state: "fresh" as const,
  access_count: 0,
  last_accessed_at: null,
  source_refs: [],
  superseded_by: null,
  archived: false,
  created_at: "2026-09-19T10:00:00.000Z",
  updated_at: "2026-09-19T10:00:00.000Z",
  project: { id: "22222222-2222-4222-8222-222222222222", slug: "hackathon-team", name: "Hackathon team", visibility: "personal" as const },
  session_id: "55555555-5555-4555-8555-555555555555",
  source: "claude-code",
  similarity: 0.8,
};

describe("MCP text (Spec 04: a text block a model can use on its own)", () => {
  it("a recall item carries author, space, session and score", () => {
    expect(toRecallItem(memory)).toMatchObject({
      type: "fact",
      text: memory.content,
      tags: ["storage"],
      space: { id: memory.project.id, name: "Hackathon team" },
      author: { id: memory.owner.user_id, name: "Ana" },
      session: { id: memory.session_id, source: "claude-code" },
      score: 0.8,
    });
  });

  it("a line is numbered, one line, with author, space, source and date", () => {
    expect(recallLine(toRecallItem(memory), 0)).toBe(
      `1. [decision] We chose Postgres over a graph database. — Ana, Hackathon team, claude-code, 2026-09-19 (id ${memory.id})`,
    );
  });

  it("falls back to the email, and leaves out a missing source", () => {
    const item = toRecallItem({ ...memory, owner: { ...memory.owner, display_name: null }, source: null, session_id: null });
    expect(recallLine(item, 1)).toContain("— ana@example.test, Hackathon team, 2026-09-19");
    expect(item.session).toBeNull();
  });

  it("says when nothing is relevant", () => {
    expect(recallText([])).toBe(NOTHING_RELEVANT);
    expect(recallText([], { spaceName: "Hackathon team" })).toBe("Nothing relevant in Hackathon team.");
  });

  it("heads the list and ends with the recall id", () => {
    const text = recallText([toRecallItem(memory)], { recallId: "r-1" });
    expect(text.split("\n")[0]).toBe("1 fact from the spaces you can read:");
    expect(text.endsWith("recall_id: r-1")).toBe(true);
  });

  it("a save says where it went and who sees it", () => {
    expect(savedText(memory)).toBe(`Saved to Hackathon team — visible to everyone who can read that space. id ${memory.id}`);
    expect(savedText({ ...memory, visibility: "personal" })).toContain("visible to only you");
    expect(savedText({ verdict: "reject-too-long", reason: "too long.", suggested_skill: null })).toBe("Not saved: too long.");
  });

  it("lists spaces with their role", () => {
    const text = spacesText([
      { id: "a", name: "Personal", slug: "personal", my_role: "owner", is_personal: true, visibility: "personal" },
      { id: "b", name: "Board", slug: "board", my_role: "reader", is_personal: false, visibility: "personal" },
    ]);
    expect(text).toContain("1. Personal (only you) — owner");
    expect(text).toContain("2. Board — reader");
  });

  it("a brief becomes markdown, and an empty one is null", () => {
    expect(briefMarkdown(null, "Hackathon team")).toBeNull();
    const md = briefMarkdown(
      {
        project_id: memory.project_id,
        version: 1,
        generated_at: "",
        stale_at: null,
        stale: false,
        memory_count_at_generation: 1,
        episode_count_at_generation: 0,
        summary: "We build a context cloud.",
        themes: [{ name: "Storage", description: "Postgres only", memory_ids: [], episode_ids: [] }],
        key_decisions: [{ summary: "No graph database", episode_id: null, decided_at: null }],
        open_questions: [],
        stats: {},
      },
      "Hackathon team",
    );
    expect(md).toBe(
      "# Hackathon team\n\nWe build a context cloud.\n\n## Key decisions\n- No graph database\n\n## Themes\n- Storage: Postgres only",
    );
  });
});
