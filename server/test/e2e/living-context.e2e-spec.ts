/**
 * Living context, end to end (v0.2): the REAL AppModule over HTTP against a real Postgres
 * (`describeIfDb` — skipped when DATABASE_URL is unset). Two people share a space:
 *
 *   Ana closes a session → a `process_session` job is queued → Ravi's Mac (a fake worker here:
 *   scripted results instead of a model) claims it, looks up neighbours and pages, posts a result
 *   → the server re-validates and applies it → Ana and Ravi both see the page, its sections cite
 *   Ana (the session's author, not Ravi's worker), quote-less facts are dropped, a locked section
 *   is never overwritten, the brief follows, recall and MCP serve both. A stranger claims nothing.
 *
 * Embeddings: with OPENKT_TEST_EMBED_URL set (an OpenAI-compatible /v1/embeddings, e.g. the
 * llama.cpp Qwen3-Embedding server) the vector paths run; without it every embedding is
 * unavailable and the exact-text / keyword fallbacks run. Both must pass.
 */
import { randomUUID } from "node:crypto";

import { RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";

import { McpServerFactoryService } from "../../apps/server/src/modules/mcp/services/mcp-server-factory.service";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const ENV_KEYS = [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE", "OPENKT_EMBEDDING_BACKEND", "OPENKT_OPENAI_EMBED_URL", "OPENKT_OPENAI_EMBED_MODEL", "OPENAI_API_KEY", "OPENKT_DISABLE_SESSION_SWEEP"];
const PASSWORD = "plum-Tractor-91";
const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@living.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

type Person = { token: string; user: { id: string; email: string; display_name: string }; email: string };

const TURNS = [
  { role: "user", content: "For the hackathon demo we decided to present the offline sync feature first, because judges asked about it twice." },
  { role: "assistant", content: "Noted. The demo order is offline sync first, then the shared pages view. Ravi owns the slides." },
  { role: "user", content: "Also the staging server runs on port 4100 behind Caddy, and the demo account is the one Sam set up yesterday." },
];

function actorContextFor(userId: string, email: string): ActorContext {
  return {
    principal: { type: "user", userId, email, displayName: null, authSource: "mcp-token", tokenId: null, serviceName: null },
    request: { requestId: "living-e2e", ip: "127.0.0.1", userAgent: "jest", referer: null, origin: null, sessionId: null, surface: "mcp", actorKind: "agent" },
    sb: new Proxy({}, { get() { throw new Error("unexpected Supabase access"); } }) as ActorContext["sb"],
    admin: () => { throw new Error("unexpected Supabase admin access"); },
  };
}

describeIfDb("Living context: jobs, pages, briefs (e2e)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const as = (p: Person) => ({
    get: (path: string) => http().get(path).set(bearer(p.token)),
    post: (path: string, body: unknown = {}) => http().post(path).set(bearer(p.token)).send(body as object),
    put: (path: string, body: unknown) => http().put(path).set(bearer(p.token)).send(body as object),
  });

  let ana: Person;
  let ravi: Person;
  let sam: Person; // a reader of the space
  let stranger: Person;
  let spaceId: string;

  async function signup(label: string, displayName: string): Promise<Person> {
    const email = freshEmail(label);
    const res = await http().post("/v1/auth/signup").set("X-Forwarded-For", freshIp()).send({ email, password: PASSWORD, display_name: displayName }).expect(201);
    return { token: res.body.data.token, user: res.body.data.user, email };
  }

  async function closedSession(p: Person, title: string | null, turns = TURNS): Promise<string> {
    const s = await as(p).post("/v1/sessions", { project_id: spaceId, source: "claude-code", title }).expect(201);
    for (const t of turns) await as(p).post(`/v1/sessions/${s.body.data.id}/turns`, t).expect(201);
    await as(p).post(`/v1/sessions/${s.body.data.id}/close`, {}).expect(200);
    return s.body.data.id as string;
  }

  /** Claims jobs until one of `kind` for `sessionId` (or any, when omitted) comes back. */
  async function claim(p: Person, kinds: string[]) {
    const res = await as(p).post("/v1/jobs/claim", { kinds, worker: "jest" }).expect(200);
    return res.body.data as { job: { id: string; kind: string; session_id: string | null; project_id: string; attempts: number } | null; input?: Record<string, any> };
  }

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of SUPABASE_KEYS) delete process.env[key];
    process.env.OPENKT_MEMORY_ENGINE = "local";
    process.env.OPENKT_DISABLE_SESSION_SWEEP = "1";
    process.env.OPENKT_EMBEDDING_BACKEND = "openai";
    if (process.env.OPENKT_TEST_EMBED_URL) {
      process.env.OPENKT_OPENAI_EMBED_URL = process.env.OPENKT_TEST_EMBED_URL;
      process.env.OPENKT_OPENAI_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B";
      process.env.OPENAI_API_KEY = "local";
    } else {
      delete process.env.OPENAI_API_KEY; // no key → every embedding is unavailable, at once
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    const { AppModule } = await import("../../apps/server/src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.set("trust proxy", true);
    app.useBodyParser("json", { limit: "3mb" });
    app.setGlobalPrefix("v1", { exclude: [{ path: "mcp", method: RequestMethod.ALL }] });
    await app.init();

    [ana, ravi, sam, stranger] = await Promise.all([
      signup("ana", "Ana Lima"),
      signup("ravi", "Ravi Kumar"),
      signup("sam", "Sam Reader"),
      signup("stranger", "Stu Stranger"),
    ]);
    const space = await as(ana).post("/v1/projects", { slug: `hack-${run}`, name: "Hackathon team", visibility: "personal" }).expect(201);
    spaceId = space.body.data.id;
    await as(ana).put(`/v1/projects/${spaceId}/grants`, { email: ravi.email, role: "editor" }).expect(200);
    await as(ana).put(`/v1/projects/${spaceId}/grants`, { email: sam.email, role: "reader" }).expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (spaceId) await pool.query(`delete from projects where id = $1`, [spaceId]);
    await pool.query(`delete from login_attempts where email like $1 or email is null`, [`%-${run}-%@living.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let firstSession: string;
  let pageId: string;
  let planSectionId: string;
  const factA = randomUUID();
  const factB = randomUUID();
  const factFake = randomUUID();
  const factSecret = randomUUID();

  it("closing a session queues one process_session job; a stranger and a reader claim nothing", async () => {
    firstSession = await closedSession(ana, null);
    const jobs = await pool.query(`select kind, status, project_id from jobs where session_id = $1`, [firstSession]);
    expect(jobs.rows).toEqual([{ kind: "process_session", status: "queued", project_id: spaceId }]);

    // Closing it again does not queue it twice.
    await as(ana).post(`/v1/sessions/${firstSession}/close`, {}).expect(200);
    expect((await pool.query(`select count(*)::int as n from jobs where session_id = $1`, [firstSession])).rows[0].n).toBe(1);

    expect((await claim(stranger, ["process_session"])).job).toBeNull();
    expect((await claim(sam, ["process_session"])).job).toBeNull();
  });

  it("a session with under 200 characters of text is not queued", async () => {
    const tiny = await closedSession(ana, "tiny", [{ role: "user", content: "ok thanks" }]);
    expect((await pool.query(`select count(*)::int as n from jobs where session_id = $1`, [tiny])).rows[0].n).toBe(0);
  });

  it("Ravi's worker claims Ana's session with everything it needs, and a lease", async () => {
    const claimed = await claim(ravi, ["process_session"]);
    expect(claimed.job).toMatchObject({ kind: "process_session", session_id: firstSession, project_id: spaceId, attempts: 1 });
    const input = claimed.input!;
    expect(input.space).toEqual({ id: spaceId, name: "Hackathon team" });
    expect(input.session.author).toEqual({ id: ana.user.id, name: "Ana Lima" });
    expect(input.turns.map((t: { content: string }) => t.content)).toEqual(TURNS.map((t) => t.content));
    const row = await pool.query(`select status, claimed_by, lease_until > now() + interval '4 minutes' as leased from jobs where id = $1`, [claimed.job!.id]);
    expect(row.rows[0]).toEqual({ status: "claimed", claimed_by: ravi.user.id, leased: true });

    // Only the lease holder may look up or complete it.
    await as(ana).post(`/v1/jobs/${claimed.job!.id}/lookup`, { facts: [] }).expect(404);
    await as(stranger).post(`/v1/jobs/${claimed.job!.id}/complete`, { result: {} }).expect(409);

    const lookup = await as(ravi).post(`/v1/jobs/${claimed.job!.id}/lookup`, { facts: [{ id: factA, statement: "The demo presents offline sync first." }] }).expect(200);
    expect(lookup.body.data.pages).toEqual([]); // a new space has no pages yet
    expect(Object.keys(lookup.body.data.neighbours)).toEqual([factA]);

    const done = await as(ravi)
      .post(`/v1/jobs/${claimed.job!.id}/complete`, {
        result: {
          summary: { title: "Hackathon demo order", summary: "Ana and the assistant settled the demo order.", open_questions: [] },
          facts: [
            { id: factA, statement: "The hackathon demo presents the offline sync feature first because judges asked about it twice.", quote: "we decided to present the offline sync feature first, because judges asked about it twice", kind: "decision", tags: ["Demo", "offline-sync"] },
            { id: factB, statement: "Ravi owns the hackathon demo slides.", quote: "Ravi owns the slides", kind: "action", tags: ["demo"] },
            { id: factFake, statement: "The demo will be recorded on video.", quote: "we will record the whole demo on video", kind: "decision", tags: [] },
            { id: factSecret, statement: "The staging password is hunter2-2026.", quote: "the staging server runs on port 4100 behind Caddy", kind: "fact", tags: [] },
          ],
          sections: [
            {
              page_id: null,
              new_page_title: "Hackathon — demo plan",
              heading: "Plan",
              body_md: `The demo opens with offline sync because judges asked about it twice [^f:${factA}].\n\n- Ravi owns the slides [^f:${factB}].\n- The demo is recorded on video [^f:${factFake}].`,
              mode: "append",
            },
          ],
          stats: { model: "fake", runtime: "jest" },
        },
      })
      .expect(200);
    expect(done.body.data.applied.facts).toEqual({ saved: 2, duplicates: 0, superseded: 0, dropped: { quote_not_found: 1, secret: 1 } });
    expect(done.body.data.applied.sections).toEqual({ written: 1, fallback: 0, refused: {} });
    expect(done.body.data.applied.pages.created).toBe(1);

    // Saved as Ana's facts — the session's author, never the worker — with their quotes.
    const facts = await pool.query(`select id, owner_user_id, kind::text as kind, visibility::text as visibility, quote, session_id from memories where session_id = $1 order by content`, [firstSession]);
    expect(facts.rows).toEqual([
      { id: factB, owner_user_id: ana.user.id, kind: "note", visibility: "project", quote: "Ravi owns the slides", session_id: firstSession },
      { id: factA, owner_user_id: ana.user.id, kind: "decision", visibility: "project", quote: "we decided to present the offline sync feature first, because judges asked about it twice", session_id: firstSession },
    ]);
    const tags = await pool.query(`select t.slug from memory_tags mt join tags t on t.id = mt.tag_id where mt.memory_id = $1 order by t.slug`, [factB]);
    expect(tags.rows.map((r) => r.slug)).toEqual(["action", "demo"]);

    // The session gained its title and summary, and the record of what was extracted.
    const session = await as(ana).get(`/v1/sessions/${firstSession}`).expect(200);
    expect(session.body.data.session.title).toBe("Hackathon demo order");
    expect(session.body.data.session.metadata.extraction).toMatchObject({ facts: 2, dropped_by_reason: { quote_not_found: 1, secret: 1 }, processed_by: ravi.user.id, model: "fake" });
  });

  it("Ana and Ravi both see the page; its sources name Ana; the fabricated fact left no sentence behind", async () => {
    for (const p of [ana, ravi, sam]) {
      const list = await as(p).get(`/v1/projects/${spaceId}/pages`).expect(200);
      expect(list.body.data.map((x: { title: string }) => x.title)).toEqual(["Hackathon — demo plan"]);
      expect(list.body.data[0]).toMatchObject({ session_count: 1, section_count: 1 });
      expect(list.body.meta.processing).toMatchObject({ queued: 0, claimed: 0, last_done_by: { id: ravi.user.id, name: "Ravi Kumar" } });
    }
    await as(stranger).get(`/v1/projects/${spaceId}/pages`).expect(404);

    pageId = (await as(ana).get(`/v1/projects/${spaceId}/pages`)).body.data[0].id;
    await as(stranger).get(`/v1/pages/${pageId}`).expect(404);
    const page = (await as(ravi).get(`/v1/pages/${pageId}`).expect(200)).body.data;
    planSectionId = page.sections[0].id;
    expect(page.sections).toEqual([
      expect.objectContaining({
        heading: "Plan",
        locked: false,
        body_md: "The demo opens with offline sync because judges asked about it twice [^1].\n\n- Ravi owns the slides [^1].",
        citations: [
          { fact_id: factA, n: 1 },
          { fact_id: factB, n: 1 },
        ],
      }),
    ]);
    expect(page.sources).toEqual([
      expect.objectContaining({
        n: 1,
        session: expect.objectContaining({ id: firstSession, title: "Hackathon demo order", source: "claude-code", author: { id: ana.user.id, name: "Ana Lima" } }),
        author: { id: ana.user.id, name: "Ana Lima" },
      }),
    ]);
    expect(page.summary).toBe("The demo opens with offline sync because judges asked about it twice. Ravi owns the slides.");
  });

  it("a reader cannot edit; an editor's edit locks the section and writes a revision", async () => {
    const edit = { body_md: "Offline sync goes first. Ana will rehearse it on Friday." };
    const refused = await as(sam).put(`/v1/pages/${pageId}/sections/${planSectionId}`, edit).expect(403);
    expect(refused.body.error.code).toBe("insufficient_role");
    await as(stranger).put(`/v1/pages/${pageId}/sections/${planSectionId}`, edit).expect(404);

    const before = (await pool.query(`select count(*)::int as n from page_revisions where page_id = $1`, [pageId])).rows[0].n;
    const edited = (await as(ana).put(`/v1/pages/${pageId}/sections/${planSectionId}`, edit).expect(200)).body.data;
    expect(edited.sections[0]).toMatchObject({ locked: true, body_md: edit.body_md });
    const revs = await pool.query(`select actor, reason from page_revisions where page_id = $1 order by created_at desc limit 1`, [pageId]);
    expect(revs.rows[0]).toEqual({ actor: `user:${ana.user.id}`, reason: "edited by a person" });
    expect((await pool.query(`select count(*)::int as n from page_revisions where page_id = $1`, [pageId])).rows[0].n).toBe(before + 1);
  });

  it("the brief follows the page: a refresh_brief job, claimed by Ravi's worker, stored for the space", async () => {
    const claimed = await claim(ravi, ["refresh_brief"]);
    expect(claimed.job).toMatchObject({ kind: "refresh_brief", project_id: spaceId });
    expect(claimed.input!.pages).toEqual([expect.objectContaining({ title: "Hackathon — demo plan" })]);
    const brief = "## What matters now\n- Offline sync opens the demo (Hackathon — demo plan)";
    await as(ravi).post(`/v1/jobs/${claimed.job!.id}/complete`, { result: { brief_md: brief, source_hash: claimed.input!.source_hash } }).expect(200);
    for (const p of [ana, sam]) {
      const got = await as(p).get(`/v1/projects/${spaceId}/brief`).expect(200);
      expect(got.body.data.brief_md).toBe(brief);
    }
    await as(stranger).get(`/v1/projects/${spaceId}/brief`).expect(404);
  });

  it("a second session's writes never overwrite the locked section; new facts go to Updates", async () => {
    const second = await closedSession(ana, "Rehearsal notes", [
      { role: "user", content: "Rehearsal update: offline sync still goes first, but the shared pages demo now needs the projector adapter from Sam." },
      { role: "assistant", content: "Understood. I will note that the shared pages demo depends on the projector adapter Sam is bringing." },
    ]);
    const claimed = await claim(ravi, ["process_session"]);
    expect(claimed.job!.session_id).toBe(second);
    const lookup = (await as(ravi).post(`/v1/jobs/${claimed.job!.id}/lookup`, { facts: [{ id: randomUUID(), statement: "The shared pages demo needs the projector adapter." }] }).expect(200)).body.data;
    expect(lookup.pages.map((p: { id: string }) => p.id)).toEqual([pageId]);
    expect(lookup.pages[0].sections[0]).toMatchObject({ id: planSectionId, locked: true });

    const factC = randomUUID();
    const done = await as(ravi)
      .post(`/v1/jobs/${claimed.job!.id}/complete`, {
        result: {
          facts: [{ id: factC, statement: "The shared pages demo needs the projector adapter that Sam is bringing.", quote: "the shared pages demo now needs the projector adapter from Sam", kind: "issue", tags: ["demo"] }],
          sections: [
            // A buggy or malicious worker aiming at the locked section: refused.
            { page_id: pageId, section_id: planSectionId, heading: "Plan", body_md: `Overwritten [^f:${factC}].`, mode: "rewrite_section" },
            // The right place: the page's Updates section.
            { page_id: pageId, heading: "Updates", body_md: `- The shared pages demo needs Sam's projector adapter [^f:${factC}].`, mode: "append" },
          ],
        },
      })
      .expect(200);
    expect(done.body.data.applied.sections).toEqual({ written: 1, fallback: 0, refused: { locked: 1 } });
    const page = (await as(ana).get(`/v1/pages/${pageId}`).expect(200)).body.data;
    expect(page.sections.map((s: { heading: string; locked: boolean; body_md: string }) => [s.heading, s.locked, s.body_md])).toEqual([
      ["Plan", true, "Offline sync goes first. Ana will rehearse it on Friday."],
      ["Updates", false, "- The shared pages demo needs Sam's projector adapter [^1]."],
    ]);
    expect(page.sources[0].session.id).toBe(second);
  });

  it("an invalid section body becomes the deterministic append; foreign citations are never written", async () => {
    // Another space, and a fact in it, that Ravi's worker tries to cite from this space.
    const other = await as(stranger).post("/v1/projects", { slug: `other-${run}`, name: "Other", visibility: "personal" }).expect(201);
    const foreign = await as(stranger).post("/v1/memories", { project_id: other.body.data.id, content: "A fact from a space Ana's team cannot read.", kind: "fact" }).expect(201);
    const loose = await as(ana).post("/v1/memories", { project_id: spaceId, content: "The team's demo laptop is Ravi's MacBook Air.", kind: "fact" }).expect(201);
    const third = await closedSession(ana, "Venue", [
      { role: "user", content: "The venue opens at 8am on Saturday and the team table is number 14, next to the power strip by the window." },
      { role: "assistant", content: "Got it: doors open at 8am on Saturday, and our table is number 14 near the window power strip." },
    ]);
    const claimed = await claim(ravi, ["process_session"]);
    expect(claimed.job!.session_id).toBe(third);
    // Earlier facts no page cites yet are offered to the router again (Spec 02 §5); cited ones and other spaces' are not.
    expect(claimed.input!.unrouted_facts.map((f: { id: string }) => f.id)).toEqual([loose.body.data.id]);
    const factD = randomUUID();
    const done = await as(ravi)
      .post(`/v1/jobs/${claimed.job!.id}/complete`, {
        result: {
          facts: [{ id: factD, statement: "The hackathon team sits at table 14 next to the window power strip.", quote: "the team table is number 14, next to the power strip by the window", kind: "fact", tags: [] }],
          sections: [
            { page_id: null, new_page_title: "Hackathon — venue", heading: "Logistics", body_md: `Table 14 by the window [^f:${factD}]. Also see [^f:${foreign.body.data.id}].\n\nAn uncited sentence.`, mode: "append" },
          ],
        },
      })
      .expect(200);
    expect(done.body.data.applied.sections).toEqual({ written: 1, fallback: 1, refused: {} });
    const pages = (await as(ana).get(`/v1/projects/${spaceId}/pages`)).body.data;
    const venue = pages.find((p: { title: string }) => p.title === "Hackathon — venue");
    const section = (await pool.query(`select body_md from page_sections where page_id = $1`, [venue.id])).rows[0];
    expect(section.body_md).toBe(`- The hackathon team sits at table 14 next to the window power strip. [^f:${factD}]`);
    const cites = await pool.query(`select memory_id from page_section_facts f join page_sections s on s.id = f.section_id where s.page_id = $1`, [venue.id]);
    expect(cites.rows).toEqual([{ memory_id: factD }]);
  });

  it("a worker that gives up: back-off, then failed after the sixth attempt", async () => {
    const fourth = await closedSession(ana, "Give up", [
      { role: "user", content: "A session the worker cannot process for some reason, long enough to be queued for processing by a Mac." },
      { role: "assistant", content: "Understood, this one exists only to exercise the retry and back-off path of the job queue, nothing more." },
    ]);
    for (let attempt = 1; attempt <= 6; attempt++) {
      // Make it due again instead of waiting 2^attempts minutes.
      await pool.query(`update jobs set run_after = now() where session_id = $1`, [fourth]);
      const claimed = await claim(ravi, ["process_session"]);
      expect(claimed.job).toMatchObject({ session_id: fourth, attempts: attempt });
      const before = Date.now();
      const failed = (await as(ravi).post(`/v1/jobs/${claimed.job!.id}/fail`, { error: "model endpoint down" }).expect(200)).body.data;
      if (attempt < 6) {
        expect(failed.status).toBe("queued");
        const delayMinutes = (Date.parse(failed.run_after) - before) / 60_000;
        expect(delayMinutes).toBeGreaterThan(2 ** attempt - 0.1);
        expect(delayMinutes).toBeLessThan(2 ** attempt + 0.1);
      } else {
        expect(failed).toMatchObject({ status: "failed", run_after: null });
      }
    }
    const row = await pool.query(`select status, attempts from jobs where session_id = $1`, [fourth]);
    expect(row.rows[0]).toEqual({ status: "failed", attempts: 6 });
  });

  it("two workers claiming at once never get the same job", async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 6; i++) sessions.push(await closedSession(ana, `Parallel ${i}`));
    const claims = await Promise.all([...Array(10)].map((_, i) => claim(i % 2 ? ravi : ana, ["process_session"])));
    const ids = claims.map((c) => c.job?.id).filter(Boolean);
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("recall returns page sections next to facts, grant-filtered", async () => {
    const anaRecall = await as(ana).post("/v1/memories/recall", { project_id: spaceId, query: "projector adapter", limit: 5 }).expect(200);
    expect(anaRecall.body.meta.sections[0]).toEqual(
      expect.objectContaining({ type: "section", heading: "Updates", page: { id: pageId, title: "Hackathon — demo plan" }, space: { id: spaceId, name: "Hackathon team" } }),
    );
    expect(anaRecall.body.meta.sections[0].text).toBe("- The shared pages demo needs Sam's projector adapter.");
    await as(stranger).post("/v1/memories/recall", { project_id: spaceId, query: "projector adapter" }).expect(404);
  });

  it("MCP: kt_page returns the page as markdown; kt_session_start carries the space brief", async () => {
    const factory = app.get(McpServerFactoryService);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = await factory.build(actorContextFor(sam.user.id, sam.email));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "living-e2e", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const text = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })).content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
    try {
      const page = await text("kt_page", { project: spaceId, title: "demo plan" });
      expect(page).toContain("# Hackathon — demo plan");
      expect(page).toContain("## Plan (edited by a person)");
      expect(page).toContain("[^1]: Rehearsal notes — Ana Lima, claude-code,");
      const byId = await text("kt_page", { page_id: pageId });
      expect(byId).toBe(page);

      const serverAna = await factory.build(actorContextFor(ana.user.id, ana.email));
      const [c2, s2] = InMemoryTransport.createLinkedPair();
      const clientAna = new Client({ name: "living-e2e-ana", version: "0.0.1" });
      await Promise.all([serverAna.connect(s2), clientAna.connect(c2)]);
      // Spec 04: the brief as text, then the session id; the same as structuredContent.
      const started = await clientAna.callTool({ name: "kt_session_start", arguments: { project: spaceId, title: "next" } });
      const content = started.content as { text: string }[];
      expect((started.structuredContent as { brief_md: string }).brief_md).toBe("## What matters now\n- Offline sync opens the demo (Hackathon — demo plan)");
      expect(content[0]!.text.startsWith("## What matters now\n- Offline sync opens the demo (Hackathon — demo plan)\n\nSession open in ")).toBe(true);
      expect(content[0]!.text).toContain("Your session id is ");
      await clientAna.close();
      await serverAna.close();

      const strangerServer = await factory.build(actorContextFor(stranger.user.id, stranger.email));
      const [c3, s3] = InMemoryTransport.createLinkedPair();
      const strangerClient = new Client({ name: "living-e2e-stranger", version: "0.0.1" });
      await Promise.all([strangerServer.connect(s3), strangerClient.connect(c3)]);
      const refused = await strangerClient.callTool({ name: "kt_page", arguments: { page_id: pageId } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).not.toContain("demo plan");
      await strangerClient.close();
      await strangerServer.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
