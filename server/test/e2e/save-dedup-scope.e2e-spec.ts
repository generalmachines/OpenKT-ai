/**
 * S4 (QA, PR #94): a near-duplicate save (cosine ≥ 0.92) merged into ANOTHER
 * session's fact and returned it, so the new session showed "Context · 0" and
 * the save touched a fact the saver never wrote. A merge now happens only
 * inside the same space AND the same session (or both without one); anything
 * else is saved as a new fact in the saver's session. An exact duplicate in
 * another session is saved too, rather than refused.
 * Embeddings come from a local stand-in (support/fake-embedder.ts): statements
 * with the same words have cosine 1.
 */
import { startFakeEmbedder } from "./support/fake-embedder";
import { HttpApp, type Person } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("Near-duplicate saves merge only within the same space and session (e2e)", () => {
  const t = new HttpApp();
  let embedder: { url: string; close: () => Promise<void> };
  let ana: Person;
  let bob: Person;
  let team: string;

  beforeAll(async () => {
    embedder = await startFakeEmbedder();
    await t.start({ OPENKT_BGE_URL: embedder.url, OPENKT_EMBEDDING_BACKEND: "bge", OPENKT_SYNTHESIS_MODE: "dedup-only" });
    ana = await t.signup("ana-dedup", "Ana");
    bob = await t.signup("bob-dedup", "Bob");
    team = await t.space(ana, "Infra team", bob, "editor");
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await embedder?.close();
  });

  async function openSession(p: Person, projectId: string): Promise<string> {
    return (await t.as(p).post("/v1/sessions", { source: "note", project_id: projectId }).expect(201)).body.data.id;
  }

  function save(p: Person, content: string, extra: Record<string, unknown>) {
    return t.as(p).post("/v1/memories", { content, kind: "fact", project_id: team, ...extra });
  }

  it("the same session: a near-duplicate merges into the fact already there", async () => {
    const tag = t.tag("same");
    const s = await openSession(ana, team);
    const first = (await save(ana, `We host everything on AWS in Mumbai ${tag}.`, { session_id: s }).expect(201)).body.data;
    const again = (await save(ana, `we host everything on aws in mumbai ${tag}!`, { session_id: s }).expect(201)).body.data;
    expect(again.id).toBe(first.id);
  });

  it("another session: a near-duplicate is a new fact in the saver's session, not the other one", async () => {
    const tag = t.tag("other");
    const sessionA = await openSession(ana, team);
    const anas = (await save(ana, `Deploys go out on Thursdays ${tag}.`, { session_id: sessionA }).expect(201)).body.data;

    const sessionB = await openSession(bob, team);
    const bobs = (await save(bob, `deploys go out on thursdays ${tag}!`, { session_id: sessionB }).expect(201)).body.data;
    expect(bobs.id).not.toBe(anas.id);
    expect(bobs.session_id).toBe(sessionB);
    expect(bobs.owner.user_id).toBe(bob.user.id);

    const b = await t.as(bob).get(`/v1/sessions/${sessionB}`).expect(200);
    expect(b.body.data.memories.map((m: { id: string }) => m.id)).toEqual([bobs.id]);
    const a = await t.as(ana).get(`/v1/sessions/${sessionA}`).expect(200);
    expect(a.body.data.memories.map((m: { id: string }) => m.id)).toEqual([anas.id]);
  });

  it("no session vs a session: never merged across", async () => {
    const tag = t.tag("loose");
    const loose = (await save(ana, `The staging database is Postgres 16 ${tag}.`, {}).expect(201)).body.data;
    const s = await openSession(ana, team);
    const inSession = (await save(ana, `the staging database is postgres 16 ${tag}!`, { session_id: s }).expect(201)).body.data;
    expect(inSession.id).not.toBe(loose.id);
    expect(inSession.session_id).toBe(s);
  });

  it("an exact duplicate in another session is saved, not refused", async () => {
    const tag = t.tag("exact");
    const content = `Invoices are sent on the 1st ${tag}.`;
    const s1 = await openSession(ana, team);
    const s2 = await openSession(bob, team);
    const one = (await save(ana, content, { session_id: s1 }).expect(201)).body.data;
    const two = (await save(bob, content, { session_id: s2 }).expect(201)).body.data;
    expect(two.id).not.toBe(one.id);
    expect(two.session_id).toBe(s2);
  });
});
