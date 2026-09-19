/**
 * Access holes, end to end: the REAL AppModule over HTTP (REST and `/mcp`),
 * real signed-up accounts, a real Postgres (`describeIfDb` — skipped when
 * DATABASE_URL is unset). Three people:
 *
 *   owner    — owns the spaces and sessions below
 *   grantee  — holds exactly the grants each test gives them
 *   stranger — holds nothing
 *
 * Each block pins one finding from the pre-open-source access review. Every
 * test that asserts the fixed behaviour failed on main at 7307030:
 *
 *   1. search authorised only `project_ids[0]` → a stranger who listed their own
 *      space first read any other space's facts. Now every id is authorised and
 *      one unreadable id is a 404 for the whole request (Spec 04: existence is
 *      not leaked — the error is the same whichever id failed, and whether that
 *      space exists at all).
 *   2. the workspace ring put every org-visibility space of an org into a
 *      grantee's recall, although the grantee was never an org member.
 *   3. a session-only grantee got 404 on recall; now they get that session's
 *      facts and nothing else from the space.
 *   4. `GET /v1/sessions/:id` handed transcripts (turns) to readers; turns need
 *      editor or owner (Spec 04).
 *   5. saves stored secrets as-is; every save path now answers 422
 *      `contains_secret`, naming the kind of secret and never echoing it.
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
const PASSWORD = "plum-Tractor-91";

const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `sec-${label}-${run}-${++counter}@e2e.openkt.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;
const slug = (label: string) => `${label}-${run}-${++counter}`;

// Test-only secrets: well-known documentation values, not live credentials.
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const DB_URL = "postgres://admin:s3cretpw@db.example.com/prod";
const PRIVATE_KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----";

interface Person {
  id: string;
  email: string;
  token: string;
  personalSpaceId: string;
}

describeIfDb("Access holes (e2e, real AppModule over HTTP)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  let owner: Person;
  let grantee: Person;
  let stranger: Person;

  const http = () => request(app.getHttpServer());
  const auth = (p: Person) => ({ Authorization: `Bearer ${p.token}` });
  const post = (p: Person, path: string, body: unknown) => http().post(path).set(auth(p)).send(body as object);
  const put = (p: Person, path: string, body: unknown) => http().put(path).set(auth(p)).send(body as object);
  const get = (p: Person, path: string) => http().get(path).set(auth(p));

  async function signup(label: string): Promise<Person> {
    const email = freshEmail(label);
    const res = await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: `Sec ${label}` })
      .expect(201);
    const token = res.body.data.token as string;
    const person = { id: res.body.data.user.id as string, email, token, personalSpaceId: "" };
    const personal = await get(person, "/v1/projects/personal").expect(200);
    person.personalSpaceId = personal.body.data.id as string;
    return person;
  }

  async function createSpace(p: Person, label: string, orgId?: string): Promise<string> {
    const res = await post(p, "/v1/projects", {
      slug: slug(label),
      name: `Sec ${label}`,
      visibility: orgId ? "org" : "personal",
      org_id: orgId ?? null,
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  async function saveFact(p: Person, projectId: string, content: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await post(p, "/v1/memories", { content, kind: "fact", project_id: projectId, visibility: "project", ...extra });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  async function openSession(p: Person, projectId: string, title: string): Promise<string> {
    const res = await post(p, "/v1/sessions", { project_id: projectId, source: "claude-code", title });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  const shareSpace = (projectId: string, withPerson: Person, role: "reader" | "editor") =>
    put(owner, `/v1/projects/${projectId}/grants`, { email: withPerson.email, role }).expect(200);
  const shareSession = (sessionId: string, withPerson: Person, role: "reader" | "editor") =>
    put(owner, `/v1/sessions/${sessionId}/grants`, { email: withPerson.email, role }).expect(200);

  const search = (p: Person, projectIds: string[], query = "") =>
    post(p, "/v1/memories/search", { query, mode: "keyword", filters: { project_ids: projectIds } });
  const recall = (p: Person, projectId: string, query: string) =>
    post(p, "/v1/memories/recall", { project_id: projectId, query, limit: 50 });
  const ids = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((m) => m.id);

  // One JSON-RPC tools/call over the real Streamable HTTP endpoint.
  async function mcpTool(p: Person, name: string, args: Record<string, unknown>) {
    const res = await http()
      .post("/mcp")
      .set(auth(p))
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: ++counter, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    const result = res.body.result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    return { isError: result.isError === true, text: result.content.map((c) => c.text ?? "").join("\n"), raw: res.text };
  }

  beforeAll(async () => {
    for (const key of [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE", "OPENKT_GOOGLE_CLIENT_IDS"]) savedEnv[key] = process.env[key];
    for (const key of SUPABASE_KEYS) delete process.env[key];
    delete process.env.OPENKT_GOOGLE_CLIENT_IDS;
    process.env.OPENKT_MEMORY_ENGINE = "local";
    pool = new Pool({ connectionString: DATABASE_URL });
    const { AppModule } = await import("../../apps/server/src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.set("trust proxy", true);
    app.setGlobalPrefix("v1", { exclude: [{ path: "mcp", method: RequestMethod.ALL }] });
    await app.init();

    owner = await signup("owner");
    grantee = await signup("grantee");
    stranger = await signup("stranger");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool.query(`delete from login_attempts where email like $1 or email is null`, [`%-${run}-%@e2e.openkt.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── 1 ──────────────────────────────────────────────────────────────
  describe("1 · search authorises every space it is given", () => {
    let ownerSpace: string;
    let factId: string;
    const FACT = "Crossread marker: the Halcyon contract renews on the first of March.";

    beforeAll(async () => {
      ownerSpace = await createSpace(owner, "acme");
      factId = await saveFact(owner, ownerSpace, FACT);
    });

    it("a stranger who lists their own space first gets 404, not the other space's facts (REST)", async () => {
      const res = await search(stranger, [stranger.personalSpaceId, ownerSpace], "Halcyon");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.text).not.toContain("Halcyon");
    });

    it("the same over MCP kt_search_memories", async () => {
      const out = await mcpTool(stranger, "kt_search_memories", {
        query: "Halcyon",
        mode: "keyword",
        filters: { project_ids: [stranger.personalSpaceId, ownerSpace] },
      });
      expect(out.isError).toBe(true);
      expect(out.raw).not.toContain("Halcyon");
    });

    it("the 404 does not say which id failed, or whether that space exists", async () => {
      const foreign = await search(stranger, [stranger.personalSpaceId, ownerSpace]);
      const missing = await search(stranger, [stranger.personalSpaceId, randomUUID()]);
      const first = await search(stranger, [ownerSpace, stranger.personalSpaceId]);
      for (const res of [foreign, missing, first]) expect(res.status).toBe(404);
      const shape = (res: request.Response) => ({ code: res.body.error.code, message: res.body.error.message, details: res.body.error.details });
      expect(shape(missing)).toEqual(shape(foreign));
      expect(shape(first)).toEqual(shape(foreign));
    });

    it("a stranger's own space alone still works and holds none of the owner's facts", async () => {
      const res = await search(stranger, [stranger.personalSpaceId], "Halcyon").expect(200);
      expect(ids(res)).not.toContain(factId);
    });

    it("a grantee may search every space they can read, together", async () => {
      await shareSpace(ownerSpace, grantee, "reader");
      const res = await search(grantee, [grantee.personalSpaceId, ownerSpace], "Halcyon").expect(200);
      expect(ids(res)).toContain(factId);
    });
  });

  // ── 2 ──────────────────────────────────────────────────────────────
  describe("2 · the workspace ring holds only spaces the caller can read", () => {
    let sharedSpace: string;
    let siblingSpace: string;
    let siblingFact: string;
    let sharedFact: string;

    beforeAll(async () => {
      const org = await post(owner, "/v1/orgs", { slug: slug("org"), name: "Sec org" });
      expect(org.status).toBe(201);
      const orgId = org.body.data.id as string;
      sharedSpace = await createSpace(owner, "shared", orgId);
      siblingSpace = await createSpace(owner, "sibling", orgId);
      sharedFact = await saveFact(owner, sharedSpace, "Ringcheck: the shared space ships on Tuesdays.");
      siblingFact = await saveFact(owner, siblingSpace, "Ringcheck: the sibling space holds the payroll vendor shortlist.");
      await shareSpace(sharedSpace, grantee, "reader");
    });

    it("a grantee on one org space does not recall the org's other spaces", async () => {
      const res = await recall(grantee, sharedSpace, "Ringcheck").expect(200);
      expect(ids(res)).toContain(sharedFact);
      expect(ids(res)).not.toContain(siblingFact);
      expect(res.text).not.toContain("payroll");
    });

    it("…nor through search", async () => {
      const res = await search(grantee, [sharedSpace], "Ringcheck").expect(200);
      expect(ids(res)).toContain(sharedFact);
      expect(ids(res)).not.toContain(siblingFact);
    });

    it("an org member still gets the whole ring", async () => {
      const res = await recall(owner, sharedSpace, "Ringcheck").expect(200);
      expect(ids(res)).toEqual(expect.arrayContaining([sharedFact, siblingFact]));
    });

    it("a stranger gets 404", async () => {
      await recall(stranger, sharedSpace, "Ringcheck").expect(404);
      await recall(stranger, siblingSpace, "Ringcheck").expect(404);
    });
  });

  // ── 3 ──────────────────────────────────────────────────────────────
  describe("3 · a session-only grant reaches recall for that session and nothing else", () => {
    let space: string;
    let sharedSession: string;
    let sharedFact: string;
    let sharedPersonalFact: string;
    let otherSessionFact: string;
    let looseFact: string;

    beforeAll(async () => {
      space = await createSpace(owner, "sessions");
      sharedSession = await openSession(owner, space, "shared session");
      const otherSession = await openSession(owner, space, "other session");
      sharedFact = await saveFact(owner, space, "Freezecheck: the deploy freeze starts on the 20th.", { session_id: sharedSession });
      sharedPersonalFact = await saveFact(owner, space, "Freezecheck: I will cover the freeze on-call myself.", {
        session_id: sharedSession,
        visibility: "personal",
      });
      otherSessionFact = await saveFact(owner, space, "Freezecheck: the freeze exception list lives in the ops wiki.", {
        session_id: otherSession,
      });
      looseFact = await saveFact(owner, space, "Freezecheck: freeze reviews happen on Mondays.");
      await shareSession(sharedSession, grantee, "reader");
    });

    it("the grantee recalls that session's facts, and only those", async () => {
      const res = await recall(grantee, space, "Freezecheck").expect(200);
      expect(ids(res).sort()).toEqual([sharedFact, sharedPersonalFact].sort());
      expect(ids(res)).not.toContain(otherSessionFact);
      expect(ids(res)).not.toContain(looseFact);
    });

    it("the same over MCP kt_recall", async () => {
      const out = await mcpTool(grantee, "kt_recall", { project_id: space, query: "Freezecheck", limit: 50 });
      expect(out.isError).toBe(false);
      expect(out.text).toContain(sharedFact);
      expect(out.text).not.toContain(otherSessionFact);
      expect(out.text).not.toContain(looseFact);
    });

    it("a stranger still gets 404", async () => {
      await recall(stranger, space, "Freezecheck").expect(404);
    });
  });

  // ── 4 ──────────────────────────────────────────────────────────────
  describe("4 · session turns need editor or owner", () => {
    let space: string;
    let session: string;
    let fact: string;
    const TURN = "Turncheck: raw transcript line the reader must not see.";

    beforeAll(async () => {
      space = await createSpace(owner, "turns");
      session = await openSession(owner, space, "turns session");
      await post(owner, `/v1/sessions/${session}/turns`, { role: "user", content: TURN }).expect(201);
      fact = await saveFact(owner, space, "Turncheck: the distilled fact readers may see.", { session_id: session });
    });

    it("a reader on the space gets the session and its facts, not the turns", async () => {
      await shareSpace(space, grantee, "reader");
      const res = await get(grantee, `/v1/sessions/${session}`).expect(200);
      expect(res.body.data.session.id).toBe(session);
      expect((res.body.data.memories as Array<{ id: string }>).map((m) => m.id)).toContain(fact);
      expect(res.body.data.turns).toBeUndefined();
      expect(res.body.data.my_role).toBe("reader");
      expect(res.text).not.toContain("raw transcript line");
    });

    it("a reader grant on the session alone is the same", async () => {
      const other = await createSpace(owner, "turns-private");
      const privateSession = await openSession(owner, other, "private turns");
      await post(owner, `/v1/sessions/${privateSession}/turns`, { role: "user", content: TURN }).expect(201);
      await shareSession(privateSession, grantee, "reader");
      const res = await get(grantee, `/v1/sessions/${privateSession}`).expect(200);
      expect(res.body.data.turns).toBeUndefined();
      expect(res.body.data.my_role).toBe("reader");
      expect(res.text).not.toContain("raw transcript line");
    });

    it("the owner gets the turns", async () => {
      const res = await get(owner, `/v1/sessions/${session}`).expect(200);
      expect(res.body.data.turns).toHaveLength(1);
      expect(res.body.data.turns[0].content).toBe(TURN);
      expect(res.body.data.my_role).toBe("owner");
    });

    it("an editor gets the turns", async () => {
      await shareSpace(space, grantee, "editor");
      const res = await get(grantee, `/v1/sessions/${session}`).expect(200);
      expect(res.body.data.turns).toHaveLength(1);
      expect(res.body.data.my_role).toBe("editor");
    });

    it("a stranger gets 404", async () => {
      await get(stranger, `/v1/sessions/${session}`).expect(404);
    });
  });

  // ── 5 ──────────────────────────────────────────────────────────────
  describe("5 · every save path refuses secrets", () => {
    let space: string;

    beforeAll(async () => {
      space = await createSpace(owner, "secrets");
    });

    const expectRefused = (res: request.Response, kindLabel: RegExp, secret: string) => {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("contains_secret");
      expect(res.body.error.message).toMatch(kindLabel);
      expect(res.text).not.toContain(secret);
    };

    it("REST POST /v1/memories", async () => {
      const res = await post(owner, "/v1/memories", {
        content: `The staging deploy user signs in with ${AWS_KEY} for now.`,
        project_id: space,
      });
      expectRefused(res, /AWS access key/, AWS_KEY);
    });

    it("MCP kt_save_memory", async () => {
      const out = await mcpTool(owner, "kt_save_memory", {
        content: `CI pushes with ${GITHUB_TOKEN} until the app is set up.`,
        project_id: space,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/GitHub token/);
      expect(out.raw).not.toContain(GITHUB_TOKEN);
    });

    it("session turns", async () => {
      const session = await openSession(owner, space, "secret turns");
      const res = await post(owner, `/v1/sessions/${session}/turns`, { role: "user", content: `use ${DB_URL} to connect` });
      expectRefused(res, /connection string/, "s3cretpw");
      const detail = await get(owner, `/v1/sessions/${session}`).expect(200);
      expect(detail.body.data.turns).toHaveLength(0);
    });

    it("POST /v1/capture refuses before any model sees the prompt", async () => {
      const res = await post(owner, "/v1/capture", {
        prompt: `Remember that the deploy bot token is ${GITHUB_TOKEN} and never rotate it.`,
        project_id: space,
      });
      expectRefused(res, /GitHub token/, GITHUB_TOKEN);
    });

    it("skills text", async () => {
      const skillMd = [
        "---",
        "name: deploy-box",
        "description: How to reach the deploy box.",
        "---",
        "",
        "# Deploy box",
        "",
        PRIVATE_KEY_HEADER,
        "MIIEowIBAAKCAQEA",
      ].join("\n");
      const res = await post(owner, "/v1/skills", { title: "Deploy box", project_id: space, skill_md: skillMd });
      expectRefused(res, /private key/, "MIIEowIBAAKCAQEA");
    });

    it("nothing secret reached the database", async () => {
      const rows = await pool.query(
        `select (select count(*) from memories
                  where owner_user_id = $1 and (content like $2 or content like $3))::int as memories,
                (select count(*) from kt_session_turns t join kt_sessions s on s.id = t.session_id
                  where s.owner_user_id = $1 and t.content like $4)::int as turns`,
        [owner.id, `%${AWS_KEY}%`, `%${GITHUB_TOKEN}%`, "%s3cretpw%"],
      );
      expect(rows.rows[0]).toEqual({ memories: 0, turns: 0 });
    });

    it("ordinary text that merely talks about keys still saves", async () => {
      await saveFact(owner, space, "The API key is rotated monthly by the platform team.");
      await saveFact(owner, space, "Token refresh happens every 15 minutes.");
    });
  });
});
