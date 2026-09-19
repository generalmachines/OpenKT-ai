/**
 * Spec 04 "MCP tools": every core kt_* tool returns a text block a model can
 * use on its own — a numbered list with author, space and date for recall —
 * plus `structuredContent`; descriptions stay ≤ 2 KB. Before this, the core
 * tools answered with a raw JSON dump and no structuredContent (audit #17).
 * Real AppModule over HTTP, real Postgres (`describeIfDb`).
 */
import { HttpApp, type Person, type ToolResult } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const CORE_TOOLS = [
  "kt_session_start",
  "kt_recall",
  "kt_save_memory",
  "kt_search_memories",
  "kt_forget_memory",
  "kt_list_projects",
  "kt_project_brief",
  "kt_session_end",
];

const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

describeIfDb("MCP core tools answer in readable text plus structuredContent (e2e)", () => {
  const t = new HttpApp();
  let ana: Person;
  let sam: Person;
  let team: string;
  let readOnly: string;
  let sessionId: string;
  let factId: string;
  let fact: string;

  beforeAll(async () => {
    await t.start();
    ana = await t.signup("ana-mcp", "Ana");
    sam = await t.signup("sam-mcp", "Sam");
    team = await t.space(ana, "Hackathon team", sam, "editor");
    readOnly = await t.space(ana, "Board notes", sam, "reader");
    fact = `We picked Postgres over a graph database (${t.tag("mcp")}).`;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
  });

  it("tools/list: every description is at most 2 KB", async () => {
    const tools = await t.mcpTools(ana);
    for (const name of CORE_TOOLS) expect(tools.map((x) => x.name)).toContain(name);
    for (const tool of tools) expect(Buffer.byteLength(tool.description ?? "")).toBeLessThanOrEqual(2048);
  });

  it("kt_session_start: the brief, then the session id; structuredContent {session_id, space, brief_md}", async () => {
    const r = await t.mcp(ana, "kt_session_start", { project: team, title: "db choice", source: "claude-code" });
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text.trim().startsWith("{")).toBe(false);
    sessionId = r.structuredContent.session_id;
    expect(text).toContain(`Your session id is ${sessionId}. Pass it to kt_recall / kt_save_memory / kt_session_end.`);
    expect(r.structuredContent.space).toEqual({ id: team, name: "Hackathon team" });
    expect(r.structuredContent).toHaveProperty("brief_md");
    expect(r.structuredContent.session.id).toBe(sessionId);
  });

  it("kt_save_memory: says where it went; structuredContent {id, space, visibility}", async () => {
    const r = await t.mcp(ana, "kt_save_memory", { content: fact, kind: "decision", project: team, session_id: sessionId });
    expect(r.isError).toBeFalsy();
    factId = r.structuredContent.id;
    expect(textOf(r)).toBe(`Saved to Hackathon team — visible to everyone who can read that space. id ${factId}`);
    expect(r.structuredContent.space).toEqual({ id: team, name: "Hackathon team" });
    expect(r.structuredContent.visibility).toBe("project");
  });

  it("kt_recall: a numbered list with kind, author, space, source and date; RecallItems + recall_id", async () => {
    const r = await t.mcp(sam, "kt_recall", { query: "graph database postgres" });
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    const day = new Date().toISOString().slice(0, 10);
    expect(text).toMatch(/^1 fact from the spaces you can read:/);
    expect(text).toContain(`1. [decision] ${fact} — Ana, Hackathon team, claude-code, ${day} (id ${factId})`);
    const s = r.structuredContent;
    expect(s.recall_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(text).toContain(`recall_id: ${s.recall_id}`);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      id: factId,
      type: "fact",
      text: fact,
      kind: "decision",
      space: { id: team, name: "Hackathon team" },
      author: { id: ana.user.id, name: "Ana" },
      session: { id: sessionId, source: "claude-code" },
    });
  });

  it("kt_recall: nothing found says so", async () => {
    const r = await t.mcp(sam, "kt_recall", { query: `zebra ${t.tag("none")}` });
    expect(textOf(r)).toBe("Nothing relevant in the spaces you can read.");
    expect(r.structuredContent.items).toEqual([]);
  });

  it("kt_search_memories: the same numbered list", async () => {
    const r = await t.mcp(sam, "kt_search_memories", { query: "graph database postgres" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(`1. [decision] ${fact} — Ana, Hackathon team`);
    expect(r.structuredContent.items[0].id).toBe(factId);
  });

  it("kt_list_projects: writable spaces first, each with my_role", async () => {
    const r = await t.mcp(sam, "kt_list_projects", {});
    expect(r.isError).toBeFalsy();
    const spaces = r.structuredContent.projects as { id: string; my_role: string; is_personal: boolean }[];
    const roles = spaces.map((s) => s.my_role);
    expect(roles.indexOf("reader")).toBeGreaterThan(roles.lastIndexOf("editor"));
    expect(spaces.find((s) => s.id === team)?.my_role).toBe("editor");
    expect(spaces.find((s) => s.id === readOnly)?.my_role).toBe("reader");
    expect(spaces.find((s) => s.is_personal)?.my_role).toBe("owner");
    const text = textOf(r);
    expect(text).toMatch(/^3 spaces you can read \(writable first\):/);
    expect(text).toContain("Hackathon team — editor");
    expect(text).toContain("Board notes — reader");
  });

  it("kt_project_brief: markdown text; structuredContent {space, brief_md}", async () => {
    const r = await t.mcp(ana, "kt_project_brief", { project_id: team });
    expect(r.isError).toBeFalsy();
    expect(textOf(r).trim().startsWith("{")).toBe(false);
    expect(r.structuredContent.space).toEqual({ id: team, name: "Hackathon team" });
    expect(r.structuredContent).toHaveProperty("brief_md");
  });

  it("kt_session_end: the fact count", async () => {
    const r = await t.mcp(ana, "kt_session_end", { session_id: sessionId, summary: "Chose Postgres." });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.fact_count).toBe(1);
    expect(textOf(r)).toBe("Session closed with 1 fact saved in it.");
  });

  it("kt_forget_memory: says what happened", async () => {
    const r = await t.mcp(ana, "kt_forget_memory", { id: factId });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(`Archived ${factId}; it no longer comes up in recall.`);
    expect(r.structuredContent).toMatchObject({ id: factId, archived: true, hard: false });
  });
});
