/**
 * MCP Apps cards over the real /mcp endpoint (AppModule, real Postgres —
 * skipped when DATABASE_URL is unset).
 *
 * - A client that does not advertise `io.modelcontextprotocol/ui` sees no card
 *   tools and no ui:// resource; one that does (in `initialize`, then through
 *   the Mcp-Session-Id it gets back, or per request in `_meta` as the
 *   2026-07-28 revision does) sees kt_save_card, kt_search_card,
 *   kt_session_card and the app-only kt_commit_save / kt_mark_used.
 * - resources/read of ui://openkt/cards.html returns the bundle with MIME
 *   text/html;profile=mcp-app.
 * - kt_save_card writes nothing and offers only writable spaces;
 *   kt_commit_save performs a real save (checked in the database and through
 *   kt_search_card); a reader cannot commit into a space.
 */
import { randomUUID } from "node:crypto";

import { RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const PASSWORD = "amber-Lantern-73";
const UI_CAPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
const CARD_TOOLS = ["kt_save_card", "kt_search_card", "kt_session_card", "kt_commit_save", "kt_mark_used"];

const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@cards.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

type Tool = { name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] }; [k: string]: unknown } };

describeIfDb("MCP Apps cards (e2e)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  let ownerToken: string;
  let readerToken: string;
  let readerEmail: string;
  let spaceId: string;

  async function signup(label: string) {
    const email = freshEmail(label);
    const res = await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: `${label} person` })
      .expect(201);
    return { token: res.body.data.token as string, email };
  }

  function rpc(token: string, method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const req = http()
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json");
    if (sessionId) req.set("Mcp-Session-Id", sessionId);
    return req.send({ jsonrpc: "2.0", id: ++counter, method, params });
  }

  async function initialize(token: string, capabilities: Record<string, unknown>) {
    const res = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities,
      clientInfo: { name: "cards-e2e", version: "0" },
    }).expect(200);
    return res.headers["mcp-session-id"] as string;
  }

  async function toolNames(token: string, sessionId?: string, params: Record<string, unknown> = {}) {
    const res = await rpc(token, "tools/list", params, sessionId).expect(200);
    return res.body.result.tools as Tool[];
  }

  async function callTool(token: string, sessionId: string, name: string, args: Record<string, unknown>) {
    const res = await rpc(token, "tools/call", { name, arguments: args }, sessionId).expect(200);
    return res.body as { result?: { content: Array<{ type: string; text: string }>; structuredContent?: any; isError?: boolean }; error?: { message: string } };
  }

  beforeAll(async () => {
    for (const key of [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE"]) savedEnv[key] = process.env[key];
    for (const key of SUPABASE_KEYS) delete process.env[key];
    process.env.OPENKT_MEMORY_ENGINE = "local";
    pool = new Pool({ connectionString: DATABASE_URL });
    const { AppModule } = await import("../../apps/server/src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.set("trust proxy", true);
    app.setGlobalPrefix("v1", { exclude: [{ path: "mcp", method: RequestMethod.ALL }] });
    await app.init();

    const owner = await signup("owner");
    ownerToken = owner.token;
    const reader = await signup("reader");
    readerToken = reader.token;
    readerEmail = reader.email;

    const space = await http()
      .post("/v1/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ slug: `cards-${run}`, name: `Cards team ${run}` });
    if (space.status !== 201) throw new Error(JSON.stringify(space.body));
    spaceId = space.body.data.id;
    await http()
      .put(`/v1/projects/${spaceId}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: readerEmail, role: "reader" })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool.query(`delete from login_attempts where email like $1`, [`%-${run}-%@cards.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a client without the UI extension sees no card tools and no ui:// resource", async () => {
    const sid = await initialize(ownerToken, {});
    expect(sid).toMatch(/^okt1\.no\./);
    const names = (await toolNames(ownerToken, sid)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["kt_recall", "kt_save_memory"]));
    for (const card of CARD_TOOLS) expect(names).not.toContain(card);
    // No header at all (a client that never echoes the session id): same.
    const bare = (await toolNames(ownerToken)).map((t) => t.name);
    expect(bare).not.toContain("kt_save_card");
    const resources = await rpc(ownerToken, "resources/list", {}, sid);
    expect(JSON.stringify(resources.body)).not.toContain("ui://openkt/cards.html");
  });

  it("a client that advertises io.modelcontextprotocol/ui at initialize gets the card tools with _meta.ui", async () => {
    const sid = await initialize(ownerToken, UI_CAPS);
    expect(sid).toMatch(/^okt1\.ui\./);
    const tools = await toolNames(ownerToken, sid);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const card of CARD_TOOLS) expect(byName.has(card)).toBe(true);
    expect(byName.get("kt_save_card")!._meta).toMatchObject({
      ui: { resourceUri: "ui://openkt/cards.html", visibility: ["model", "app"] },
      "ui/resourceUri": "ui://openkt/cards.html",
      "openai/outputTemplate": "ui://openkt/cards.html",
    });
    expect(byName.get("kt_commit_save")!._meta!.ui).toEqual({ resourceUri: "ui://openkt/cards.html", visibility: ["app"] });
    expect(byName.get("kt_mark_used")!._meta!.ui!.visibility).toEqual(["app"]);
    // The plain tools are unchanged.
    expect(byName.get("kt_save_memory")!._meta?.ui).toBeUndefined();
  });

  it("a 2026-07-28 client that sends clientCapabilities in _meta per request gets them too", async () => {
    const tools = await toolNames(ownerToken, undefined, {
      _meta: { "io.modelcontextprotocol/clientCapabilities": UI_CAPS, "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    });
    expect(tools.map((t) => t.name)).toContain("kt_save_card");
  });

  it("resources/read returns the cards bundle as text/html;profile=mcp-app", async () => {
    const sid = await initialize(ownerToken, UI_CAPS);
    const list = await rpc(ownerToken, "resources/list", {}, sid).expect(200);
    expect(list.body.result.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: "ui://openkt/cards.html", mimeType: "text/html;profile=mcp-app" })]),
    );
    const read = await rpc(ownerToken, "resources/read", { uri: "ui://openkt/cards.html" }, sid).expect(200);
    const [content] = read.body.result.contents;
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toMatch(/^<!doctype html>/i);
    expect(content.text).toContain("kt_commit_save");
    expect(content.text).not.toMatch(/<script[^>]+src=/);
    expect(content.text.length).toBeGreaterThan(100_000);
  });

  it("kt_save_card writes nothing and offers only the spaces the caller can write to", async () => {
    const statement = `Cards e2e ${run}: ship the connector on Tuesdays.`;
    const ownerSid = await initialize(ownerToken, UI_CAPS);
    const card = await callTool(ownerToken, ownerSid, "kt_save_card", { content: statement, kind: "decision", suggested_project: spaceId });
    expect(card.result!.content[0]!.text).toContain("NOT saved yet");
    const sc = card.result!.structuredContent;
    expect(sc).toMatchObject({ view: "save", statement, kind: "decision", default_space_id: spaceId });
    expect(sc.spaces).toEqual([expect.objectContaining({ id: spaceId, name: `Cards team ${run}`, writable: true })]);
    expect(sc.personal.project).toEqual(expect.any(String));
    const { rows } = await pool.query(`select count(*)::int as n from memories where content = $1`, [statement]);
    expect(rows[0].n).toBe(0);

    // The reader is offered only "Only me" — never a space they can only read.
    const readerSid = await initialize(readerToken, UI_CAPS);
    const readerCard = await callTool(readerToken, readerSid, "kt_save_card", { content: statement });
    expect(readerCard.result!.structuredContent.spaces).toEqual([]);
  });

  it("kt_commit_save performs a real save; kt_search_card finds it; a reader cannot commit into the space", async () => {
    const statement = `Cards e2e ${run}: the demo space is called Cards team.`;
    const sid = await initialize(ownerToken, UI_CAPS);
    // Exactly what the card sends (packages/mcp-cards/src/model.js commitArgs).
    const saved = await callTool(ownerToken, sid, "kt_commit_save", {
      content: statement,
      kind: "decision",
      visibility: "project",
      project: spaceId,
    });
    expect(saved.result!.isError).toBeFalsy();
    expect(saved.result!.content[0]!.text).toContain(`Saved to Cards team ${run}`);
    const id = saved.result!.structuredContent.id as string;
    const { rows } = await pool.query(`select project_id, content, kind from memories where id = $1`, [id]);
    expect(rows[0]).toEqual({ project_id: spaceId, content: statement, kind: "decision" });

    // The reader finds it through the search card, with the owner as author.
    const readerSid = await initialize(readerToken, UI_CAPS);
    const found = await callTool(readerToken, readerSid, "kt_search_card", { query: "demo space called Cards team", project: spaceId });
    expect(found.result!.structuredContent.view).toBe("search");
    const hit = (found.result!.structuredContent.items as Array<{ id: string; author: string }>).find((i) => i.id === id);
    expect(hit).toBeDefined();
    expect(hit!.author).toBe("owner person");
    expect(found.result!.content[0]!.text).toContain(statement);

    const used = await callTool(readerToken, readerSid, "kt_mark_used", { id, recall_id: found.result!.structuredContent.recall_id });
    expect(used.result!.structuredContent).toMatchObject({ ok: true, id });

    const refused = await callTool(readerToken, readerSid, "kt_commit_save", {
      content: `Cards e2e ${run}: a reader tries to write.`,
      visibility: "project",
      project: spaceId,
    });
    expect(refused.result!.isError).toBe(true);
    expect(refused.result!.content[0]!.text).toMatch(/^Not saved/);

    // "Only me" goes to the personal space with personal visibility.
    const mine = await callTool(readerToken, readerSid, "kt_commit_save", { content: `Cards e2e ${run}: my own note.`, visibility: "personal" });
    expect(mine.result!.structuredContent.visibility).toBe("personal");
  });

  it("kt_session_card summarises a session and what it kept", async () => {
    const sid = await initialize(ownerToken, UI_CAPS);
    const started = await callTool(ownerToken, sid, "kt_session_start", { project: spaceId, title: "Cards session" });
    const sessionId = started.result!.structuredContent.session_id as string;
    await callTool(ownerToken, sid, "kt_save_memory", {
      content: `Cards e2e ${run}: sessions show what they kept.`,
      kind: "fact",
      project_id: spaceId,
      session_id: sessionId,
    });
    const card = await callTool(ownerToken, sid, "kt_session_card", { session_id: sessionId });
    expect(card.result!.structuredContent).toMatchObject({ view: "session", title: "Cards session", space: `Cards team ${run}` });
    expect(card.result!.structuredContent.facts).toHaveLength(1);
    expect(card.result!.content[0]!.text).toContain("1 item kept");
  });

  it("a teammate made an editor saves into the shared space (card and kt_save_memory)", async () => {
    const editor = await signup("editor");
    await http()
      .put(`/v1/projects/${spaceId}/grants`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: editor.email, role: "editor" })
      .expect(200);
    const sid = await initialize(editor.token, UI_CAPS);

    const card = await callTool(editor.token, sid, "kt_save_card", { content: "x", suggested_project: spaceId });
    expect(card.result!.structuredContent.spaces.map((s: { id: string }) => s.id)).toEqual([spaceId]);

    const committed = await callTool(editor.token, sid, "kt_commit_save", {
      content: `Cards e2e ${run}: an editor saves through the card.`,
      kind: "action",
      visibility: "project",
      project: spaceId,
    });
    expect(committed.result!.isError).toBeFalsy();
    expect(committed.result!.structuredContent.space.id).toBe(spaceId);

    const direct = await callTool(editor.token, sid, "kt_save_memory", {
      content: `Cards e2e ${run}: an editor saves directly.`,
      kind: "fact",
      project_id: spaceId,
    });
    expect(direct.result!.isError).toBeFalsy();
    const saved = direct.result!.structuredContent.memory as { project: { id: string }; owner: { display_name: string } };
    expect(saved.project.id).toBe(spaceId);
    expect(saved.owner.display_name).toBe("editor person");

    // The owner recalls the editor's fact, with the editor as author.
    const ownerSid = await initialize(ownerToken, {});
    const recalled = await callTool(ownerToken, ownerSid, "kt_recall", { query: "an editor saves directly", project_id: spaceId });
    const items = recalled.result!.structuredContent.items as Array<{ text: string; author: { name: string } }>;
    expect(items.find((r) => r.text.includes("an editor saves directly"))?.author.name).toBe("editor person");
  });

  it("without the extension the app-only tools do not exist", async () => {
    const sid = await initialize(ownerToken, {});
    const res = await callTool(ownerToken, sid, "kt_commit_save", { content: "x", visibility: "personal" });
    expect(res.result?.isError ?? Boolean(res.error)).toBe(true);
  });
});
