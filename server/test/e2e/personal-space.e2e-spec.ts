/**
 * The personal space is ONE marked project, never "some space you own".
 *
 * S0 (QA, PR #94): once a person owned more than one org-less space,
 * `GET /v1/projects/personal` — and every save or session with no project
 * (REST `POST /v1/memories`, MCP `kt_save_memory`, `kt_session_start`) — could
 * resolve to a TEAM space, so a note meant for "Personal" was filed where a
 * teammate recalls it. The real AppModule over HTTP against a real Postgres
 * (`describeIfDb`).
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
const PASSWORD = "correct horse battery 42";
const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@personal.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

type Person = { token: string; user: { id: string; email: string }; email: string };

describeIfDb("The personal space is the marked one, never a shared space (e2e)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const as = (p: Person) => ({
    get: (path: string) => http().get(path).set(bearer(p.token)),
    post: (path: string, body: unknown = {}) => http().post(path).set(bearer(p.token)).send(body as object),
    put: (path: string, body: unknown = {}) => http().put(path).set(bearer(p.token)).send(body as object),
  });

  async function signup(label: string): Promise<Person> {
    const email = freshEmail(label);
    const res = await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: label })
      .expect(201);
    return { token: res.body.data.token, user: res.body.data.user, email };
  }

  async function team(owner: Person, name: string, teammate?: Person): Promise<string> {
    const res = await as(owner).post("/v1/projects", { name }).expect(201);
    const id = res.body.data.id as string;
    if (teammate) {
      await as(owner).put(`/v1/projects/${id}/grants`, { email: teammate.email, role: "editor" }).expect(200);
    }
    return id;
  }

  async function mcp(p: Person, name: string, args: Record<string, unknown>) {
    const res = await http()
      .post("/mcp")
      .set(bearer(p.token))
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    const payload = res.text.startsWith("{")
      ? JSON.parse(res.text)
      : JSON.parse(res.text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    return payload.result as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
  }

  // The project a tool result names, whether it carries structuredContent or
  // only JSON text.
  function projectIdOf(result: { content: { type: string; text: string }[]; structuredContent?: any }, key: "memory" | "session"): string {
    const s = result.structuredContent;
    if (s) return key === "memory" ? (s.memory?.project_id ?? s.project_id) : s.session.project_id;
    const body = JSON.parse(result.content[0]!.text);
    return key === "memory" ? body.project_id : body.session.project_id;
  }

  async function recallIn(p: Person, projectId: string, query: string): Promise<string[]> {
    const res = await as(p).post("/v1/memories/recall", { project_id: projectId, query, limit: 50 }).expect(200);
    return (res.body.data as { content: string }[]).map((m) => m.content);
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a person with Personal and two shared spaces saves with no project → Personal, over REST and MCP", async () => {
    const ana = await signup("ana");
    const bob = await signup("bob");
    const personal = (await as(ana).get("/v1/projects/personal").expect(200)).body.data;
    expect(personal.slug).toBe("personal");
    expect(personal.is_personal).toBe(true);

    const teamA = await team(ana, "Launch crew", bob);
    const teamB = await team(ana, "Pricing crew", bob);

    // GET /v1/projects/personal keeps naming the same space.
    expect((await as(ana).get("/v1/projects/personal").expect(200)).body.data.id).toBe(personal.id);

    const restNote = `rest-private-${run}: my salary expectation is private`;
    const rest = await as(ana).post("/v1/memories", { content: restNote, kind: "note" }).expect(201);
    expect(rest.body.data.project_id).toBe(personal.id);

    const mcpNote = `mcp-private-${run}: my review of Bob is private`;
    const saved = await mcp(ana, "kt_save_memory", { content: mcpNote, kind: "note" });
    expect(saved.isError).toBeFalsy();
    expect(projectIdOf(saved, "memory")).toBe(personal.id);

    const started = await mcp(ana, "kt_session_start", { title: "private thinking" });
    expect(started.isError).toBeFalsy();
    expect(projectIdOf(started, "session")).toBe(personal.id);

    const sessionRes = await as(ana).post("/v1/sessions", { source: "note" }).expect(201);
    expect(sessionRes.body.data.project_id).toBe(personal.id);

    // The teammate never sees either note in the spaces shared with him.
    for (const space of [teamA, teamB]) {
      const seen = await recallIn(bob, space, "private");
      expect(seen).not.toContain(restNote);
      expect(seen).not.toContain(mcpNote);
    }

    // Only the personal space is marked; team spaces are not.
    const listed = (await as(ana).get("/v1/projects").expect(200)).body.data as { id: string; is_personal: boolean }[];
    expect(listed.filter((p) => p.is_personal).map((p) => p.id)).toEqual([personal.id]);
  });

  it("an account with no personal space yet never gets a shared space as its personal one", async () => {
    const ana = await signup("ana-nopersonal");
    const bob = await signup("bob-nopersonal");
    // Accounts made before sign-up created the personal space (or by another
    // sign-in path) own only what they created themselves.
    await pool.query("delete from projects where owner_user_id = $1", [ana.user.id]);

    const teamA = await team(ana, "Hackathon team", bob);
    const teamB = await team(ana, "Side project", bob);

    const personal = (await as(ana).get("/v1/projects/personal").expect(200)).body.data;
    expect([teamA, teamB]).not.toContain(personal.id);
    expect(personal.slug).toBe("personal");
    expect(personal.is_personal).toBe(true);

    const note = `nopersonal-${run}: my private worry about the demo`;
    const rest = await as(ana).post("/v1/memories", { content: note, kind: "note" }).expect(201);
    expect(rest.body.data.project_id).toBe(personal.id);

    const mcpNote = `nopersonal-mcp-${run}: another private worry`;
    const saved = await mcp(ana, "kt_save_memory", { content: mcpNote, kind: "note" });
    expect(projectIdOf(saved, "memory")).toBe(personal.id);

    for (const space of [teamA, teamB]) {
      const seen = await recallIn(bob, space, "private worry");
      expect(seen).not.toContain(note);
      expect(seen).not.toContain(mcpNote);
    }
  });

  it("concurrent first uses create exactly one personal space", async () => {
    const ana = await signup("ana-race");
    await pool.query("delete from projects where owner_user_id = $1", [ana.user.id]);
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => as(ana).get("/v1/projects/personal").expect(200).then((r) => r.body.data.id as string)),
    );
    expect(new Set(ids).size).toBe(1);
    const { rows } = await pool.query("select count(*)::int as n from projects where owner_user_id = $1", [ana.user.id]);
    expect(rows[0].n).toBe(1);
  });
});
