/**
 * Sessions shared with me, and moving a session between spaces.
 *
 * S1 (QA, PR #94): nothing listed the sessions someone shared with me —
 * `GET /v1/sessions` as the grantee was `[]` although `GET /v1/sessions/:id`
 * worked. Now `GET /v1/sessions?shared=true` lists them, newest first, each
 * with `my_role` and the owner's name (never their email); every list item
 * carries `my_role`.
 *
 * (a) (#98): `PATCH /v1/sessions/:id {project_id?, title?}` — the session's
 * owner moves it into another space they can write; its facts move with it.
 * Real AppModule over HTTP, real Postgres (`describeIfDb`).
 */
import { HttpApp, type Person } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("Sessions shared with me, and moving a session (e2e)", () => {
  const t = new HttpApp();
  let ana: Person;
  let bob: Person;
  let eve: Person;

  beforeAll(async () => {
    await t.start();
    ana = await t.signup("ana-shared", "Ana");
    bob = await t.signup("bob-shared", "Bob");
    eve = await t.signup("eve-shared", "Eve");
  }, 60_000);

  afterAll(async () => {
    await t.stop();
  });

  async function session(p: Person, body: Record<string, unknown> = {}): Promise<string> {
    return (await t.as(p).post("/v1/sessions", { source: "note", ...body }).expect(201)).body.data.id;
  }

  describe("GET /v1/sessions?shared=true (S1)", () => {
    let readerOne: string;
    let editorOne: string;
    let notShared: string;

    beforeAll(async () => {
      readerOne = await session(ana, { title: "pricing call" });
      editorOne = await session(ana, { title: "demo prep" });
      notShared = await session(ana, { title: "private" });
      await t.as(ana).put(`/v1/sessions/${readerOne}/grants`, { email: bob.email, role: "reader" }).expect(200);
      await t.as(ana).put(`/v1/sessions/${editorOne}/grants`, { email: bob.email, role: "editor" }).expect(200);
      await session(bob, { title: "bob's own" });
    });

    it("lists the sessions shared with me, newest first, with my_role and the owner's name", async () => {
      const res = await t.as(bob).get("/v1/sessions?shared=true").expect(200);
      const rows = res.body.data as Array<{ id: string; my_role: string; owner: { id: string; name: string } & Record<string, unknown> }>;
      expect(rows.map((r) => r.id)).toEqual([editorOne, readerOne]);
      expect(rows.map((r) => r.my_role)).toEqual(["editor", "reader"]);
      expect(rows[0]!.owner).toEqual({ id: ana.user.id, name: "Ana" });
      expect(JSON.stringify(res.body)).not.toContain(ana.email);
      expect(rows.map((r) => r.id)).not.toContain(notShared);
      expect(res.body.meta.total).toBe(2);
    });

    it("nobody else sees them", async () => {
      const res = await t.as(eve).get("/v1/sessions?shared=true").expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("the default list is unchanged and carries my_role", async () => {
      const res = await t.as(ana).get("/v1/sessions").expect(200);
      const rows = res.body.data as Array<{ id: string; my_role: string }>;
      expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([readerOne, editorOne, notShared]));
      expect(new Set(rows.map((r) => r.my_role))).toEqual(new Set(["owner"]));
    });

    it("a revoked grant drops the session from the list", async () => {
      await t.as(ana).delete(`/v1/sessions/${readerOne}/grants/${bob.user.id}`).expect(200);
      const res = await t.as(bob).get("/v1/sessions?shared=true").expect(200);
      expect((res.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual([editorOne]);
    });
  });

  describe("PATCH /v1/sessions/:id (a)", () => {
    it("the owner moves a session into a space they can write; its facts move with it", async () => {
      const team = await t.space(ana, "Launch team", bob, "reader");
      const id = await session(ana, { title: "draft" });
      const fact = `Moved fact ${t.tag("move")}: launch on Tuesday.`;
      const saved = (await t.as(ana).post("/v1/memories", { content: fact, kind: "decision", session_id: id }).expect(201)).body.data;

      // Before the move the teammate cannot recall it.
      const before = await t.as(bob).post("/v1/memories/recall", { query: `launch tuesday ${t.tag("move")}` }).expect(200);
      expect((before.body.data as { id: string }[]).map((m) => m.id)).not.toContain(saved.id);

      const res = await t.as(ana).patch(`/v1/sessions/${id}`, { project_id: team, title: "Launch plan" }).expect(200);
      expect(res.body.data.project_id).toBe(team);
      expect(res.body.data.title).toBe("Launch plan");

      const detail = await t.as(ana).get(`/v1/sessions/${id}`).expect(200);
      expect(detail.body.data.memories.map((m: { id: string; project_id: string }) => [m.id, m.project_id])).toEqual([[saved.id, team]]);

      // After it, the space's reader recalls the fact.
      const after = await t.as(bob).post("/v1/memories/recall", { query: `launch tuesday ${t.tag("move")}` }).expect(200);
      expect((after.body.data as { id: string }[]).map((m) => m.id)).toContain(saved.id);
    });

    it("a title alone can be changed; a secret in it is refused", async () => {
      const id = await session(ana);
      const res = await t.as(ana).patch(`/v1/sessions/${id}`, { title: "Renamed" }).expect(200);
      expect(res.body.data.title).toBe("Renamed");
      await t.as(ana).patch(`/v1/sessions/${id}`, { title: "key AKIAIOSFODNN7EXAMPLE" }).expect(422);
    });

    it("moving into a space the owner cannot write is 404; only the owner may move", async () => {
      const bobsSpace = await t.space(bob, "Bob only");
      const readOnly = await t.space(bob, "Bob read-only", ana, "reader");
      const id = await session(ana);
      await t.as(ana).patch(`/v1/sessions/${id}`, { project_id: bobsSpace }).expect(404);
      await t.as(ana).patch(`/v1/sessions/${id}`, { project_id: readOnly }).expect(404);

      await t.as(ana).put(`/v1/sessions/${id}/grants`, { email: bob.email, role: "editor" }).expect(200);
      await t.as(bob).patch(`/v1/sessions/${id}`, { title: "hijack" }).expect(403);
      await t.as(eve).patch(`/v1/sessions/${id}`, { title: "hijack" }).expect(404);
    });

    it("an empty patch is a validation error", async () => {
      const id = await session(ana);
      await t.as(ana).patch(`/v1/sessions/${id}`, {}).expect(400);
    });
  });
});
