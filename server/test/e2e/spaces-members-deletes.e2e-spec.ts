/**
 * Spaces for teams, and deleting things (S5, #98 b–d):
 *   - `GET /v1/memories?project_id=` lists a space's facts for any reader of
 *     it — but never a teammate's `personal`-visibility fact;
 *   - `GET /v1/projects/:id/members`: every member sees names and roles; emails
 *     and pending shares stay owner-only (`GET …/grants`);
 *   - spaces have a `description` (POST and PATCH `/v1/projects`);
 *   - `DELETE /v1/memories/:id` (author or space editor), `DELETE
 *     /v1/sessions/:id` (owner), `DELETE /v1/projects/:id` (owner, never the
 *     personal space) — and what is deleted is gone from recall and lists.
 * Real AppModule over HTTP, real Postgres (`describeIfDb`).
 */
import { HttpApp, type Person } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("Spaces: members, descriptions, listing facts, deletes (e2e)", () => {
  const t = new HttpApp();
  let ana: Person;
  let bob: Person; // editor
  let cat: Person; // reader
  let eve: Person; // stranger
  let team: string;

  async function recallIds(p: Person, query: string): Promise<string[]> {
    const res = await t.as(p).post("/v1/memories/recall", { query, limit: 50 }).expect(200);
    return (res.body.data as { id: string }[]).map((m) => m.id);
  }

  async function save(p: Person, content: string, extra: Record<string, unknown> = {}) {
    return (await t.as(p).post("/v1/memories", { content, kind: "fact", project_id: team, ...extra }).expect(201)).body.data;
  }

  beforeAll(async () => {
    await t.start();
    ana = await t.signup("ana-spaces", "Ana");
    bob = await t.signup("bob-spaces", "Bob");
    cat = await t.signup("cat-spaces", "Cat");
    eve = await t.signup("eve-spaces", "Eve");
    team = await t.space(ana, "Northgate", bob, "editor");
    await t.as(ana).put(`/v1/projects/${team}/grants`, { email: cat.email, role: "reader" }).expect(200);
    await t.as(ana).put(`/v1/projects/${team}/grants`, { email: `nobody-${t.tag("x")}@e2e.test`, role: "reader" }).expect(200);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
  });

  describe("GET /v1/memories?project_id= (b)", () => {
    it("any reader lists the space's facts; a teammate's personal fact stays hidden", async () => {
      const shared = await save(ana, `Northgate quote is per store ${t.tag("list")}.`);
      const privateOne = await save(ana, `My private Northgate worry ${t.tag("list")}.`, { visibility: "personal" });
      const bobs = await save(bob, `Bob's Northgate note ${t.tag("list")}.`);

      for (const p of [bob, cat]) {
        const res = await t.as(p).get(`/v1/memories?project_id=${team}`).expect(200);
        const ids = (res.body.data as { id: string }[]).map((m) => m.id);
        expect(ids).toEqual(expect.arrayContaining([shared.id, bobs.id]));
        expect(ids).not.toContain(privateOne.id);
      }
      const own = await t.as(ana).get(`/v1/memories?project_id=${team}`).expect(200);
      expect((own.body.data as { id: string }[]).map((m) => m.id)).toContain(privateOne.id);
      await t.as(eve).get(`/v1/memories?project_id=${team}`).expect(404);
    });
  });

  describe("GET /v1/projects/:id/members (c)", () => {
    it("every member sees names and roles, never emails or pending shares", async () => {
      for (const p of [ana, bob, cat]) {
        const res = await t.as(p).get(`/v1/projects/${team}/members`).expect(200);
        const members = res.body.data as Array<{ user_id: string; display_name: string; role: string }>;
        expect(members).toEqual([
          { user_id: ana.user.id, display_name: "Ana", role: "owner" },
          { user_id: bob.user.id, display_name: "Bob", role: "editor" },
          { user_id: cat.user.id, display_name: "Cat", role: "reader" },
        ]);
        const text = JSON.stringify(res.body);
        for (const email of [ana.email, bob.email, cat.email, "nobody-"]) expect(text).not.toContain(email);
      }
      await t.as(eve).get(`/v1/projects/${team}/members`).expect(404);
      await t.as(eve).get(`/v1/projects/${team}`).expect(404);
      // The grants list, with emails and pending shares, stays the owner's.
      await t.as(bob).get(`/v1/projects/${team}/grants`).expect(403);
      const grants = await t.as(ana).get(`/v1/projects/${team}/grants`).expect(200);
      expect(grants.body.data.some((g: { pending: boolean }) => g.pending)).toBe(true);
    });
  });

  describe("space descriptions (d)", () => {
    it("POST takes a description; PATCH changes it (owner only)", async () => {
      const created = await t.as(ana).post("/v1/projects", { name: "Research", description: "What we learn from customers." }).expect(201);
      expect(created.body.data.description).toBe("What we learn from customers.");
      const id = created.body.data.id as string;
      const patched = await t.as(ana).patch(`/v1/projects/${id}`, { description: "Customer research, weekly." }).expect(200);
      expect(patched.body.data.description).toBe("Customer research, weekly.");
      expect((await t.as(ana).get(`/v1/projects/${id}`).expect(200)).body.data.description).toBe("Customer research, weekly.");
      const renamed = await t.as(ana).patch(`/v1/projects/${id}`, { name: "Customer research" }).expect(200);
      expect(renamed.body.data.name).toBe("Customer research");
      expect(renamed.body.data.description).toBe("Customer research, weekly.");

      await t.as(ana).patch(`/v1/projects/${team}`, { description: "Our biggest customer." }).expect(200);
      await t.as(bob).patch(`/v1/projects/${team}`, { description: "hijack" }).expect(403);
      await t.as(eve).patch(`/v1/projects/${team}`, { description: "hijack" }).expect(404);
      await t.as(ana).patch(`/v1/projects/${id}`, { description: "x".repeat(2001) }).expect(400);
      const listed = (await t.as(bob).get("/v1/projects").expect(200)).body.data as { id: string; description: string | null }[];
      expect(listed.find((p) => p.id === team)?.description).toBe("Our biggest customer.");
    });
  });

  describe("DELETE /v1/memories/:id (S5)", () => {
    it("the author or a space editor archives a fact; it leaves recall; a reader cannot", async () => {
      const tag = t.tag("delfact");
      const anas = await save(ana, `Delete me later ${tag}.`);
      const other = await save(ana, `Delete me too ${tag}.`);
      expect(await recallIds(cat, `delete ${tag}`)).toEqual(expect.arrayContaining([anas.id, other.id]));

      await t.as(cat).delete(`/v1/memories/${anas.id}`).expect(403);
      await t.as(eve).delete(`/v1/memories/${anas.id}`).expect(404);
      await t.as(bob).delete(`/v1/memories/${anas.id}`).expect(200); // editor, not the author
      await t.as(ana).delete(`/v1/memories/${other.id}`).expect(200); // the author

      for (const p of [ana, bob, cat]) {
        const ids = await recallIds(p, `delete ${tag}`);
        expect(ids).not.toContain(anas.id);
        expect(ids).not.toContain(other.id);
      }
    });

    it("an editor cannot archive a teammate's personal fact (it is not theirs to see)", async () => {
      const mine = await save(ana, `Personal in the team space ${t.tag("pers")}.`, { visibility: "personal" });
      await t.as(bob).delete(`/v1/memories/${mine.id}`).expect(404);
    });
  });

  describe("DELETE /v1/sessions/:id (S5)", () => {
    it("the owner deletes a session: it is gone, its facts leave recall, its shares go", async () => {
      const tag = t.tag("delsession");
      const s = (await t.as(ana).post("/v1/sessions", { source: "meeting", project_id: team }).expect(201)).body.data.id as string;
      await t.as(ana).post(`/v1/sessions/${s}/turns`, { role: "user", content: "a transcript line" }).expect(201);
      const fact = await save(ana, `Session fact to delete ${tag}.`, { session_id: s });
      await t.as(ana).put(`/v1/sessions/${s}/grants`, { email: eve.email, role: "reader" }).expect(200);
      expect(await recallIds(eve, `session fact delete ${tag}`)).toContain(fact.id);

      await t.as(bob).delete(`/v1/sessions/${s}`).expect(403); // an editor of the space is not the owner
      await t.as(eve).delete(`/v1/sessions/${s}`).expect(403); // a reader of the session either
      const res = await t.as(ana).delete(`/v1/sessions/${s}`).expect(200);
      expect(res.body.data).toEqual({ id: s, deleted: true, archived_facts: 1 });

      await t.as(ana).get(`/v1/sessions/${s}`).expect(404);
      await t.as(eve).get(`/v1/sessions/${s}`).expect(404);
      await t.as(ana).post(`/v1/sessions/${s}/turns`, { role: "user", content: "late" }).expect(404);
      for (const p of [ana, bob, eve]) expect(await recallIds(p, `session fact delete ${tag}`)).not.toContain(fact.id);
      const shared = await t.as(eve).get("/v1/sessions?shared=true").expect(200);
      expect((shared.body.data as { id: string }[]).map((x) => x.id)).not.toContain(s);
      const listed = await t.as(ana).get(`/v1/sessions?project_id=${team}`).expect(200);
      expect((listed.body.data as { id: string }[]).map((x) => x.id)).not.toContain(s);
      await t.as(eve).delete(`/v1/sessions/${s}`).expect(404);
    });
  });

  describe("DELETE /v1/projects/:id (S5)", () => {
    it("the owner deletes a space: it is gone for everyone, with its facts and shares", async () => {
      const tag = t.tag("delspace");
      const doomed = await t.space(ana, "Doomed", bob, "editor");
      const fact = (await t.as(bob).post("/v1/memories", { content: `Doomed fact ${tag}.`, kind: "fact", project_id: doomed }).expect(201)).body.data;
      const s = (await t.as(bob).post("/v1/sessions", { source: "note", project_id: doomed }).expect(201)).body.data.id as string;
      await t.as(bob).put(`/v1/sessions/${s}/grants`, { email: cat.email, role: "reader" }).expect(200);
      const inSession = (await t.as(bob).post("/v1/memories", { content: `Doomed session fact ${tag}.`, kind: "fact", session_id: s, project_id: doomed }).expect(201)).body.data;
      expect(await recallIds(bob, `doomed ${tag}`)).toEqual(expect.arrayContaining([fact.id, inSession.id]));

      await t.as(bob).delete(`/v1/projects/${doomed}`).expect(403);
      await t.as(eve).delete(`/v1/projects/${doomed}`).expect(404);
      const res = await t.as(ana).delete(`/v1/projects/${doomed}`).expect(200);
      expect(res.body.data).toEqual({ id: doomed, deleted: true });

      for (const p of [ana, bob]) {
        await t.as(p).get(`/v1/projects/${doomed}`).expect(404);
        const listed = (await t.as(p).get("/v1/projects").expect(200)).body.data as { id: string }[];
        expect(listed.map((x) => x.id)).not.toContain(doomed);
        await t.as(p).post("/v1/memories/recall", { query: "doomed", project_id: doomed }).expect(404);
      }
      for (const p of [ana, bob, cat]) {
        const ids = await recallIds(p, `doomed ${tag}`);
        expect(ids).not.toContain(fact.id);
        expect(ids).not.toContain(inSession.id);
      }
      await t.as(cat).get(`/v1/sessions/${s}`).expect(404);
      await t.as(bob).post("/v1/memories", { content: "into the void", kind: "fact", project_id: doomed }).expect(404);
      await t.as(ana).delete(`/v1/projects/${doomed}`).expect(404);
    });

    it("the personal space cannot be deleted", async () => {
      const personal = (await t.as(ana).get("/v1/projects/personal").expect(200)).body.data.id as string;
      await t.as(ana).delete(`/v1/projects/${personal}`).expect(400);
    });
  });
});
