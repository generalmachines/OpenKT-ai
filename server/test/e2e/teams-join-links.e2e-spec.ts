/**
 * Teams you join by link, end to end: the REAL AppModule (no Supabase) over
 * HTTP against a real Postgres (`describeIfDb`).
 *
 * Covers: `POST /v1/projects {name}` creates a team space; join links
 * (create / list / delete, who may do each); the unauthenticated preview;
 * joining through the existing grants (a stranger joins and now recalls the
 * team's facts; a reader link cannot save; expired, used-up and deleted links
 * are 404; joining never downgrades and never burns a use for nothing); the
 * MCP tools kt_create_team / kt_join_team / kt_invite_link; and the
 * zero-install pages / → /connect, /join/<code>, /connect (cookie session,
 * CSRF, access tokens shown once, create a team).
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
const PUBLIC_URL = "https://teams.example.test";
const MCP_URL = "https://mcp.teams.example.test/mcp";
const PASSWORD = "correct horse battery 42";
const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@teams.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

type Person = { token: string; user: { id: string; email: string; display_name: string }; email: string };

// The same prefix exclusions as main.ts.
async function bootApp(): Promise<NestExpressApplication> {
  for (const key of SUPABASE_KEYS) delete process.env[key];
  process.env.OPENKT_MEMORY_ENGINE = "local";
  process.env.OPENKT_PUBLIC_URL = PUBLIC_URL;
  process.env.OPENKT_MCP_URL = MCP_URL;
  const { AppModule } = await import("../../apps/server/src/app.module");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.set("trust proxy", true);
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "mcp", method: RequestMethod.ALL },
      { path: "/", method: RequestMethod.GET },
      { path: "join/:code", method: RequestMethod.GET },
      { path: "join/:code", method: RequestMethod.POST },
      { path: "connect", method: RequestMethod.GET },
      { path: "connect/(.*)", method: RequestMethod.POST },
    ],
  });
  await app.init();
  return app;
}

// Cookies from Set-Cookie headers, as a browser at `path` would send them back.
function cookieJar() {
  const jar = new Map<string, { value: string; path: string }[]>();
  return {
    take(res: request.Response) {
      const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
      for (const line of raw ?? []) {
        const [pair, ...attrs] = line.split(";").map((s) => s.trim());
        const i = pair!.indexOf("=");
        const name = pair!.slice(0, i);
        const value = decodeURIComponent(pair!.slice(i + 1));
        const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
        const expired = attrs.some((a) => /^expires=thu, 01 jan 1970/i.test(a)) || value === "";
        const kept = (jar.get(name) ?? []).filter((c) => c.path !== path);
        jar.set(name, expired ? kept : [...kept, { value, path }]);
      }
    },
    header(path: string): string {
      const out: string[] = [];
      for (const [name, entries] of jar) {
        const hit = entries.find((c) => path === c.path || path.startsWith(`${c.path}/`) || path.startsWith(`${c.path}?`));
        if (hit) out.push(`${name}=${encodeURIComponent(hit.value)}`);
      }
      return out.join("; ");
    },
    raw: jar,
  };
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

describeIfDb("Teams: join links, team MCP tools, /join and /connect pages (e2e)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const as = (p: Person) => ({
    get: (path: string) => http().get(path).set(bearer(p.token)),
    post: (path: string, body: unknown = {}) => http().post(path).set(bearer(p.token)).send(body as object),
    delete: (path: string) => http().delete(path).set(bearer(p.token)),
  });

  async function signup(label: string, displayName = `${label} Person`): Promise<Person> {
    const email = freshEmail(label);
    const res = await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: displayName })
      .expect(201);
    return { token: res.body.data.token, user: res.body.data.user, email };
  }

  async function team(owner: Person, name = "Hackathon Crew"): Promise<string> {
    const res = await as(owner).post("/v1/projects", { name }).expect(201);
    return res.body.data.id as string;
  }

  async function link(p: Person, spaceId: string, body: Record<string, unknown> = {}) {
    const res = await as(p).post(`/v1/projects/${spaceId}/join-links`, body);
    if (res.status !== 201) throw new Error(`create link: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data as { code: string; url: string; role: string; uses: number; max_uses: number | null; expires_at: string };
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

  function save(p: Person, spaceId: string, content: string) {
    return as(p).post("/v1/memories", { content, kind: "fact", project_id: spaceId });
  }

  function recall(p: Person, spaceId: string, query: string) {
    return as(p).post("/v1/memories/recall", { project_id: spaceId, query });
  }

  beforeAll(async () => {
    for (const key of [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE", "OPENKT_PUBLIC_URL", "OPENKT_MCP_URL"]) savedEnv[key] = process.env[key];
    pool = new Pool({ connectionString: DATABASE_URL });
    app = await bootApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool.query(`delete from login_attempts where email like $1`, [`%-${run}-%@teams.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("REST", () => {
    it("POST /v1/projects {name} creates a team space with a slug from the name; the personal space stays personal", async () => {
      const owner = await signup("owner");
      const first = await as(owner).post("/v1/projects", { name: "Hackathon Crew!" }).expect(201);
      expect(first.body.data).toMatchObject({ name: "Hackathon Crew!", slug: "hackathon-crew", org_id: null });
      const second = await as(owner).post("/v1/projects", { name: "hackathon crew" }).expect(201);
      expect(second.body.data.slug).toBe("hackathon-crew-2");
      const named = await as(owner).post("/v1/projects", { name: "Personal" }).expect(201);
      expect(named.body.data.slug).toBe("personal-team");
      const personal = await as(owner).get("/v1/projects/personal").expect(200);
      expect(personal.body.data.slug).toBe("personal");
    });

    it("the owner makes a link; a stranger previews it without signing in, joins, and now recalls the team's facts", async () => {
      const owner = await signup("owner", "Olga Owner");
      const spaceId = await team(owner);
      const created = await link(owner, spaceId, { role: "editor" });
      expect(created.code).toMatch(/^[A-Za-z0-9]{10}$/);
      expect(created.url).toBe(`${PUBLIC_URL}/join/${created.code}`);
      expect(created).toMatchObject({ role: "editor", uses: 0, max_uses: null });
      const days = (new Date(created.expires_at).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);

      const saved = await save(owner, spaceId, "The demo server for the hackathon runs on port 8123.");
      expect(saved.status).toBe(201);

      const stranger = await signup("stranger", "Sam Stranger");
      expect((await recall(stranger, spaceId, "demo server port")).status).toBe(404);

      const preview = await http().get(`/v1/join/${created.code}/preview`).expect(200);
      expect(preview.body.data).toEqual({ space_name: "Hackathon Crew", inviter_name: "Olga Owner", role: "editor" });
      expect(JSON.stringify(preview.body)).not.toContain(owner.email);

      const joined = await as(stranger).post("/v1/join", { code: created.code }).expect(200);
      expect(joined.body.data).toEqual({ space: { id: spaceId, name: "Hackathon Crew" }, role: "editor" });

      const recalled = await recall(stranger, spaceId, "demo server port").expect(200);
      expect((recalled.body.data as { content: string }[]).map((m) => m.content)).toContain(
        "The demo server for the hackathon runs on port 8123.",
      );
      // An editor saves into the team too, and the space is in their list.
      expect((await save(stranger, spaceId, "Judging starts at 5pm in room B.")).status).toBe(201);
      // …and the owner recalls what the newcomer saved.
      const back = await recall(owner, spaceId, "judging room").expect(200);
      expect((back.body.data as { content: string }[]).map((m) => m.content)).toContain("Judging starts at 5pm in room B.");
      const spaces = await as(stranger).get("/v1/projects").expect(200);
      expect((spaces.body.data as { id: string }[]).some((s) => s.id === spaceId)).toBe(true);

      // The access is an ordinary grant, made on behalf of the link's creator.
      const grants = await pool.query(
        `select role, created_by from grants where resource_type = 'project' and resource_id = $1 and subject_id = $2`,
        [spaceId, stranger.user.id],
      );
      expect(grants.rows).toEqual([{ role: "editor", created_by: owner.user.id }]);
      const uses = await pool.query(`select uses from join_links where code = $1`, [created.code]);
      expect(uses.rows[0].uses).toBe(1);
    });

    it("the whole link works as the code, and joining again uses nothing up", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      const created = await link(owner, spaceId, { max_uses: 1 });
      const mate = await signup("mate");
      await as(mate).post("/v1/join", { code: created.url }).expect(200);
      // Already in: the second visit is fine and the link is still "used once".
      await as(mate).post("/v1/join", { code: created.url }).expect(200);
      // The owner opening their own link is a no-op that burns nothing.
      const own = await as(owner).post("/v1/join", { code: created.code }).expect(200);
      expect(own.body.data.role).toBe("owner");
      const uses = await pool.query(`select uses from join_links where code = $1`, [created.code]);
      expect(uses.rows[0].uses).toBe(1);
    });

    it("a used-up link is 404 for the next person (max_uses 2: the 2nd joins, the 3rd does not)", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      const created = await link(owner, spaceId, { max_uses: 2, role: "reader" });
      const [a, b, c] = [await signup("a"), await signup("b"), await signup("c")];
      await as(a).post("/v1/join", { code: created.code }).expect(200);
      await http().get(`/v1/join/${created.code}/preview`).expect(200);
      await as(b).post("/v1/join", { code: created.code }).expect(200);
      await http().get(`/v1/join/${created.code}/preview`).expect(404);
      const refused = await as(c).post("/v1/join", { code: created.code }).expect(404);
      expect(refused.body.error.code).toBe("not_found");
      expect((await recall(c, spaceId, "anything")).status).toBe(404);
    });

    it("an expired link is 404; so is a code that never existed or is malformed", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      const created = await link(owner, spaceId, { expires_in_days: 1 });
      await http().get(`/v1/join/${created.code}/preview`).expect(200);
      await pool.query(`update join_links set expires_at = now() - interval '1 second' where code = $1`, [created.code]);
      await http().get(`/v1/join/${created.code}/preview`).expect(404);
      const late = await signup("late");
      await as(late).post("/v1/join", { code: created.code }).expect(404);
      await http().get(`/v1/join/Nope000000/preview`).expect(404);
      await http().get(`/v1/join/not-a-code!/preview`).expect(404);
      await as(late).post("/v1/join", { code: "https://evil.example/join/" }).expect(404);
      await as(late).post("/v1/join", {}).expect(400);
      await http().post("/v1/join").send({ code: created.code }).expect(401);
    });

    it("a reader link lets you recall but not save", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      expect((await save(owner, spaceId, "Wifi password for the venue is on the whiteboard.")).status).toBe(201);
      const created = await link(owner, spaceId, { role: "reader" });
      const reader = await signup("reader");
      const joined = await as(reader).post("/v1/join", { code: created.code }).expect(200);
      expect(joined.body.data.role).toBe("reader");
      const recalled = await recall(reader, spaceId, "venue wifi password").expect(200);
      expect((recalled.body.data as { content: string }[]).map((m) => m.content)).toContain(
        "Wifi password for the venue is on the whiteboard.",
      );
      const refused = await save(reader, spaceId, "A reader trying to write.");
      expect([403, 404]).toContain(refused.status);
      const rows = await pool.query(`select 1 from memories where project_id = $1 and content = $2`, [spaceId, "A reader trying to write."]);
      expect(rows.rowCount).toBe(0);
      // A reader cannot hand out links either.
      expect([403, 404]).toContain((await as(reader).post(`/v1/projects/${spaceId}/join-links`, { role: "reader" })).status);
    });

    it("an editor's save never collides with (or reveals) a teammate's personal memory", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      const secret = "My own reminder: renew the domain before Friday.";
      const mine = await as(owner).post("/v1/memories", { content: secret, kind: "note", project_id: spaceId, visibility: "personal" });
      expect(mine.status).toBe(201);
      const created = await link(owner, spaceId);
      const mate = await signup("mate");
      await as(mate).post("/v1/join", { code: created.code }).expect(200);
      const same = await save(mate, spaceId, secret);
      expect(same.status).toBe(201);
      expect(same.body.data.id).not.toBe(mine.body.data.id);
      expect(same.body.data.owner.user_id).toBe(mate.user.id);
      // A real duplicate of a shared fact is still caught.
      expect((await save(owner, spaceId, "Shared fact number one.")).status).toBe(201);
      const dup = await save(mate, spaceId, "Shared fact number one.");
      expect(dup.status).toBe(400);
    });

    it("joining never lowers a role: an editor who opens a reader link stays an editor", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      const editorLink = await link(owner, spaceId, { role: "editor" });
      const readerLink = await link(owner, spaceId, { role: "reader" });
      const mate = await signup("mate");
      await as(mate).post("/v1/join", { code: editorLink.code }).expect(200);
      const again = await as(mate).post("/v1/join", { code: readerLink.code }).expect(200);
      expect(again.body.data.role).toBe("editor");
      const uses = await pool.query(`select uses from join_links where code = $1`, [readerLink.code]);
      expect(uses.rows[0].uses).toBe(0);
    });

    it("an editor may make links; only the owner lists and deletes them; people who joined keep access", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      const first = await link(owner, spaceId);
      const editor = await signup("editor");
      await as(editor).post("/v1/join", { code: first.code }).expect(200);
      const byEditor = await link(editor, spaceId, { role: "reader" });
      expect(byEditor.role).toBe("reader");

      const list = await as(owner).get(`/v1/projects/${spaceId}/join-links`).expect(200);
      expect((list.body.data as { code: string }[]).map((l) => l.code).sort()).toEqual([first.code, byEditor.code].sort());
      expect(list.body.data.find((l: { code: string }) => l.code === first.code)).toMatchObject({ uses: 1, active: true });
      expect((await as(editor).get(`/v1/projects/${spaceId}/join-links`)).status).toBe(403);
      expect((await as(editor).delete(`/v1/projects/${spaceId}/join-links/${first.code}`)).status).toBe(403);
      const stranger = await signup("stranger");
      expect((await as(stranger).get(`/v1/projects/${spaceId}/join-links`)).status).toBe(404);
      expect((await as(stranger).post(`/v1/projects/${spaceId}/join-links`, {})).status).toBe(404);
      await http().get(`/v1/projects/${spaceId}/join-links`).expect(401);

      const removed = await as(owner).delete(`/v1/projects/${spaceId}/join-links/${first.code}`).expect(200);
      expect(removed.body.data).toEqual({ revoked: true });
      await http().get(`/v1/join/${first.code}/preview`).expect(404);
      await as(stranger).post("/v1/join", { code: first.code }).expect(404);
      expect((await recall(editor, spaceId, "anything")).status).toBe(200);
    });

    it("a personal space cannot be shared by link", async () => {
      const owner = await signup("owner");
      const personal = await as(owner).get("/v1/projects/personal").expect(200);
      const res = await as(owner).post(`/v1/projects/${personal.body.data.id}/join-links`, {}).expect(400);
      expect(res.body.error.message).toMatch(/personal space/);
    });

    it("rejects bad link settings", async () => {
      const owner = await signup("owner");
      const spaceId = await team(owner);
      for (const body of [{ role: "owner" }, { expires_in_days: 0 }, { expires_in_days: 366 }, { max_uses: 0 }]) {
        expect((await as(owner).post(`/v1/projects/${spaceId}/join-links`, body)).status).toBe(400);
      }
      expect((await link(owner, spaceId, { expires_in_days: 365, max_uses: 10_000 })).max_uses).toBe(10_000);
    });
  });

  describe("MCP tools", () => {
    it("kt_create_team → a space and an editor link; kt_join_team with the URL; kt_invite_link reuses the link", async () => {
      const owner = await signup("mcpowner", "Mia Owner");
      const created = await mcp(owner, "kt_create_team", { name: "Robot Arm" });
      expect(created.isError).toBeFalsy();
      const { space, join_link } = created.structuredContent;
      expect(space).toMatchObject({ name: "Robot Arm", slug: "robot-arm" });
      expect(join_link).toMatchObject({ role: "editor", url: `${PUBLIC_URL}/join/${join_link.code}` });
      expect(created.content[0]!.text).toContain(join_link.url);

      await save(owner, space.id, "The arm's servo limit is 170 degrees.");
      const mate = await signup("mcpmate");
      const joined = await mcp(mate, "kt_join_team", { code_or_url: join_link.url });
      expect(joined.isError).toBeFalsy();
      expect(joined.structuredContent).toEqual({ space: { id: space.id, name: "Robot Arm" }, role: "editor" });
      expect(joined.content[0]!.text).toContain(space.id);
      const recalled = await mcp(mate, "kt_recall", { project_id: space.id, query: "servo limit" });
      expect(recalled.content[0]!.text).toContain("170 degrees");

      const invite = await mcp(owner, "kt_invite_link", { project: space.id });
      expect(invite.structuredContent.join_link.code).toBe(join_link.code);
      const bySlug = await mcp(owner, "kt_invite_link", { project: "robot-arm", role: "reader" });
      expect(bySlug.structuredContent.join_link).toMatchObject({ role: "reader" });
      expect(bySlug.structuredContent.join_link.code).not.toBe(join_link.code);

      const bad = await mcp(mate, "kt_join_team", { code_or_url: "https://x.test/join/Missing123" });
      expect(bad.isError).toBe(true);
    });

    it("tools/list advertises the three team tools", async () => {
      const p = await signup("lister");
      const res = await http()
        .post("/mcp")
        .set(bearer(p.token))
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        .expect(200);
      for (const name of ["kt_create_team", "kt_join_team", "kt_invite_link", "kt_recall"]) expect(res.text).toContain(`"${name}"`);
    });
  });

  describe("pages", () => {
    it("GET / goes to /connect; /connect signed out is a sign-in form with CSP and no-store", async () => {
      const root = await http().get("/").expect(302);
      expect(root.headers.location).toBe("/connect");
      const page = await http().get("/connect").expect(200);
      expect(page.headers["content-type"]).toMatch(/text\/html/);
      expect(page.headers["cache-control"]).toBe("no-store");
      const csp = page.headers["content-security-policy"] as string;
      expect(csp).toMatch(/default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'/);
      expect(csp).not.toContain("unsafe-inline");
      expect(page.text).toContain('action="/connect/signin"');
      expect(csrfOf(page.text)).not.toBe("");
      // The API is untouched by the page routes.
      await http().get("/v1/health").expect(200);
      await http().get("/v1/projects").expect(401);
    });

    it("a stranger opens /join/<code>, signs up on the page, lands on /connect with the team, a token and the setup", async () => {
      const owner = await signup("pageowner", "Pia <Owner>");
      const spaceId = await team(owner, "Launch & Learn");
      await save(owner, spaceId, "Standup is at 9:30 by the stage.");
      const created = await link(owner, spaceId);
      const jar = cookieJar();

      const joinPath = `/join/${created.code}`;
      const form = await http().get(joinPath).expect(200);
      jar.take(form);
      expect(form.text).toContain("Pia &lt;Owner&gt; invited you to");
      expect(form.text).toContain("Launch &amp; Learn");
      expect(form.text).not.toContain("<Owner>");
      const csrf = csrfOf(form.text);

      // Without the page's CSRF value (a post from elsewhere) nothing happens.
      const email = freshEmail("walkin");
      const forged = await http()
        .post(joinPath)
        .set("X-Forwarded-For", freshIp())
        .set("Cookie", jar.header(joinPath))
        .type("form")
        .send({ csrf: "forged", mode: "signup", email, password: PASSWORD, display_name: "Wally" })
        .expect(400);
      expect(forged.text).toContain("expired");
      expect((await pool.query(`select 1 from user_credentials where email = $1`, [email])).rowCount).toBe(0);
      // Same with a foreign Origin, even with the right value.
      await http()
        .post(joinPath)
        .set("Cookie", jar.header(joinPath))
        .set("Origin", "https://evil.example")
        .type("form")
        .send({ csrf, mode: "signup", email, password: PASSWORD, display_name: "Wally" })
        .expect(400);

      const joined = await http()
        .post(joinPath)
        .set("X-Forwarded-For", freshIp())
        .set("Cookie", jar.header(joinPath))
        .type("form")
        .send({ csrf, mode: "signup", email, password: PASSWORD, display_name: "Wally Walkin" })
        .expect(303);
      expect(joined.headers.location).toBe(`/connect?joined=${spaceId}`);
      jar.take(joined);
      const sessionCookies = (joined.headers["set-cookie"] as unknown as string[]).filter((c) => c.startsWith("okt_web_session="));
      expect(sessionCookies.map((c) => /Path=([^;]+)/.exec(c)?.[1]).sort()).toEqual(["/connect", "/join"]);
      for (const c of sessionCookies) {
        expect(c).toMatch(/HttpOnly/);
        expect(c).toMatch(/SameSite=Lax/);
        expect(c).toMatch(/Max-Age=86400/);
      }
      const userId = (await pool.query(`select user_id from user_credentials where email = $1`, [email])).rows[0].user_id;
      const session = await pool.query(`select name, expires_at from personal_access_tokens where user_id = $1`, [userId]);
      expect(session.rows.map((r) => r.name)).toEqual(["session:web"]);
      const hours = (new Date(session.rows[0].expires_at).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThan(24.1);

      const landing = await http().get(joined.headers.location).set("Cookie", jar.header("/connect")).expect(200);
      expect(landing.text).toContain("You joined <strong>Launch &amp; Learn</strong> as editor");
      expect(landing.text).toContain(MCP_URL);
      expect(landing.text).toContain("[mcp_servers.openkt]");
      expect(landing.text).toContain("Bearer &lt;token&gt;");
      expect(landing.text).toContain("OpenKT-latest-arm64.dmg");
      expect(landing.text).toContain("xattr -dr com.apple.quarantine /Applications/OpenKT.app");
      // The paste-in prompt is plugin/SETUP-PROMPT.md, with this server's MCP URL.
      expect(landing.text).toContain("Connect **OpenKT** to the tool you are running in right now.");
      expect(landing.text).toContain(`a remote MCP server at \`${MCP_URL}\``);
      expect(landing.text).toContain("kt_list_projects");
      expect(landing.text).toContain(spaceId);

      // A fresh token for Codex, shown once and filled into the config block.
      const tokenRes = await http()
        .post("/connect/token")
        .set("Cookie", jar.header("/connect"))
        .type("form")
        .send({ csrf: csrfOf(landing.text), tool: "codex" })
        .expect(200);
      const token = /okt_pat_[0-9a-f]{64}/.exec(tokenRes.text)?.[0];
      expect(token).toBeDefined();
      expect(tokenRes.text).toContain(`[mcp_servers.openkt]\nurl = &quot;${MCP_URL}&quot;\nhttp_headers = { &quot;Authorization&quot; = &quot;Bearer ${token}&quot; }`);
      expect(tokenRes.text).toContain(`claude mcp add --transport http openkt ${MCP_URL} --header &quot;Authorization: Bearer ${token}&quot;`);
      const names = await pool.query(`select name from personal_access_tokens where user_id = $1 order by created_at`, [userId]);
      expect(names.rows.map((r) => r.name)).toEqual(["session:web", "connect:codex"]);
      // The token is a real one: the new member recalls the team's fact with it.
      const recalled = await http()
        .post("/v1/memories/recall")
        .set(bearer(token!))
        .send({ project_id: spaceId, query: "standup stage" })
        .expect(200);
      expect((recalled.body.data as { content: string }[]).map((m) => m.content)).toContain("Standup is at 9:30 by the stage.");
      // Shown once: the next render has no token in it.
      const later = await http().get("/connect").set("Cookie", jar.header("/connect")).expect(200);
      expect(later.text).not.toContain(token!);

      // Token creation without the CSRF value is refused.
      await http().post("/connect/token").set("Cookie", jar.header("/connect")).type("form").send({ tool: "cursor" }).expect(400);
      expect((await pool.query(`select 1 from personal_access_tokens where user_id = $1 and name = 'connect:cursor'`, [userId])).rowCount).toBe(0);

      // The session cookie is not a bearer for the API.
      await http().get("/v1/me").set("Cookie", jar.header("/connect")).expect(401);

      // Sign out revokes the session token and drops the cookie.
      await http().post("/connect/signout").set("Cookie", jar.header("/connect")).type("form").send({ csrf: csrfOf(later.text) }).expect(303);
      const revoked = await pool.query(`select revoked_at from personal_access_tokens where user_id = $1 and name = 'session:web'`, [userId]);
      expect(revoked.rows[0].revoked_at).not.toBeNull();
    });

    it("a signed-in visitor joins with one click; a dead link shows the not-found page", async () => {
      const owner = await signup("pageowner2");
      const spaceA = await team(owner, "Team A");
      const spaceB = await team(owner, "Team B");
      const linkA = await link(owner, spaceA);
      const linkB = await link(owner, spaceB, { role: "reader" });
      const jar = cookieJar();

      // Sign up on /connect.
      const signin = await http().get("/connect").expect(200);
      jar.take(signin);
      const email = freshEmail("clicker");
      const signedUp = await http()
        .post("/connect/signin")
        .set("X-Forwarded-For", freshIp())
        .set("Cookie", jar.header("/connect"))
        .type("form")
        .send({ csrf: csrfOf(signin.text), mode: "signup", email, password: PASSWORD, display_name: "Cleo Clicker" })
        .expect(303);
      jar.take(signedUp);
      expect(signedUp.headers.location).toBe("/connect");

      const joinA = await http().get(`/join/${linkA.code}`).set("Cookie", jar.header(`/join/${linkA.code}`)).expect(200);
      expect(joinA.text).toContain("Join as Cleo Clicker");
      const done = await http()
        .post(`/join/${linkA.code}`)
        .set("Cookie", jar.header(`/join/${linkA.code}`))
        .type("form")
        .send({ csrf: csrfOf(joinA.text), mode: "session" })
        .expect(303);
      expect(done.headers.location).toBe(`/connect?joined=${spaceA}`);

      // Existing account, signing in on the join page instead.
      const other = await signup("existing");
      const fresh = cookieJar();
      const joinB = await http().get(`/join/${linkB.code}`).expect(200);
      fresh.take(joinB);
      const wrong = await http()
        .post(`/join/${linkB.code}`)
        .set("X-Forwarded-For", freshIp())
        .set("Cookie", fresh.header(`/join/${linkB.code}`))
        .type("form")
        .send({ csrf: csrfOf(joinB.text), mode: "signin", email: other.email, password: "not the password 1" })
        .expect(401);
      expect(wrong.text).toContain("That email and password do not match");
      await http()
        .post(`/join/${linkB.code}`)
        .set("X-Forwarded-For", freshIp())
        .set("Cookie", fresh.header(`/join/${linkB.code}`))
        .type("form")
        .send({ csrf: csrfOf(joinB.text), mode: "signin", email: other.email, password: PASSWORD })
        .expect(303);
      const role = await pool.query(`select role from grants where resource_id = $1 and subject_id = $2`, [spaceB, other.user.id]);
      expect(role.rows).toEqual([{ role: "reader" }]);

      const dead = await http().get("/join/Missing123").expect(404);
      expect(dead.text).toContain("This invite link does not work");
    });

    it("create a team on /connect: the page shows the link to share, and 'New invite link' makes another", async () => {
      const jar = cookieJar();
      const signin = await http().get("/connect").expect(200);
      jar.take(signin);
      const signedUp = await http()
        .post("/connect/signin")
        .set("X-Forwarded-For", freshIp())
        .set("Cookie", jar.header("/connect"))
        .type("form")
        .send({ csrf: csrfOf(signin.text), mode: "signup", email: freshEmail("maker"), password: PASSWORD, display_name: "Max Maker" })
        .expect(303);
      jar.take(signedUp);
      const page = await http().get("/connect").set("Cookie", jar.header("/connect")).expect(200);
      expect(page.text).toContain("You are not in any team yet");

      const made = await http()
        .post("/connect/teams")
        .set("Cookie", jar.header("/connect"))
        .type("form")
        .send({ csrf: csrfOf(page.text), name: "Night Owls" })
        .expect(303);
      const spaceId = /created=([0-9a-f-]{36})/.exec(made.headers.location)?.[1];
      expect(spaceId).toBeDefined();
      const shown = await http().get(made.headers.location).set("Cookie", jar.header("/connect")).expect(200);
      const url = new RegExp(`Send this link to your team: <code>(${PUBLIC_URL}/join/[A-Za-z0-9]{10})</code>`).exec(shown.text)?.[1];
      expect(url).toBeDefined();
      const code = url!.split("/").pop()!;
      const preview = await http().get(`/v1/join/${code}/preview`).expect(200);
      expect(preview.body.data).toEqual({ space_name: "Night Owls", inviter_name: "Max Maker", role: "editor" });

      const another = await http()
        .post(`/connect/teams/${spaceId}/links`)
        .set("Cookie", jar.header("/connect"))
        .type("form")
        .send({ csrf: csrfOf(shown.text) })
        .expect(200);
      expect(another.text).toMatch(new RegExp(`New invite link — send it to whoever should join: <code>${PUBLIC_URL}/join/[A-Za-z0-9]{10}</code>`));
      const links = await pool.query(`select count(*)::int as n from join_links where project_id = $1`, [spaceId]);
      expect(links.rows[0].n).toBe(2);

      const empty = await http()
        .post("/connect/teams")
        .set("Cookie", jar.header("/connect"))
        .type("form")
        .send({ csrf: csrfOf(shown.text), name: "   " })
        .expect(400);
      expect(empty.text).toContain("Give the team a name");
    });
  });
});
