/**
 * Recall with no space given searches EVERY space the caller can read —
 * the core promise: what one person saved reaches a teammate's session.
 *
 * Three people: Ana (owner), Sam (her teammate, granted on a shared space,
 * one session, and a member of her org) and Eve (a stranger). Over REST
 * `POST /v1/memories/recall` + `POST /v1/memories/search` and MCP `kt_recall`
 * + `kt_search_memories`, with no project:
 *   - Sam recalls Ana's fact in the shared space, in the one session she
 *     shared with him, and in the org space he is a member of;
 *   - Sam never recalls Ana's private notes (her personal space, her
 *     `personal`-visibility fact in the shared space);
 *   - Eve recalls none of it;
 *   - naming a space Eve cannot read is still a 404 (#78).
 * Real AppModule over HTTP, real Postgres (`describeIfDb`); recall is
 * keyword-only here (no embedding service), so queries share words with facts.
 */
import { Pool } from "pg";

import { HttpApp, type Person } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("Recall with no space reaches every space you can read (e2e)", () => {
  const t = new HttpApp();
  let pool: Pool;
  let ana: Person;
  let sam: Person;
  let eve: Person;
  let team: string;
  let orgSpace: string;

  const facts = {
    shared: "",
    sharedPrivate: "",
    personal: "",
    session: "",
    org: "",
    unsharedSession: "",
  };

  async function recall(p: Person, query: string, extra: Record<string, unknown> = {}): Promise<string[]> {
    const res = await t.as(p).post("/v1/memories/recall", { query, limit: 50, ...extra }).expect(200);
    return (res.body.data as { content: string }[]).map((m) => m.content);
  }

  async function search(p: Person, query: string): Promise<string[]> {
    const res = await t.as(p).post("/v1/memories/search", { query, limit: 50 }).expect(200);
    return (res.body.data as { content: string }[]).map((m) => m.content);
  }

  async function mcpText(p: Person, tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await t.mcp(p, tool, args);
    expect(result.isError).toBeFalsy();
    return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await t.start();
    ana = await t.signup("ana", "Ana");
    sam = await t.signup("sam", "Sam");
    eve = await t.signup("eve", "Eve");
    const tag = t.tag("graphdb");

    // A shared space: Sam is an editor.
    team = await t.space(ana, "Hackathon team", sam, "editor");
    facts.shared = `We didn't use a graph database (${tag}): Postgres with pgvector covers our joins.`;
    await t.as(ana).post("/v1/memories", { content: facts.shared, kind: "decision", project_id: team }).expect(201);
    facts.sharedPrivate = `Only for me (${tag}): I didn't want to use a graph database either.`;
    await t.as(ana)
      .post("/v1/memories", { content: facts.sharedPrivate, kind: "note", project_id: team, visibility: "personal" })
      .expect(201);

    // Ana's personal space: a private note, plus one session she shares with Sam.
    facts.personal = `Private (${tag}): why I didn't push to use a graph database.`;
    await t.as(ana).post("/v1/memories", { content: facts.personal, kind: "note" }).expect(201);
    const session = (await t.as(ana).post("/v1/sessions", { source: "note", title: "db choice" }).expect(201)).body.data;
    facts.session = `Session fact (${tag}): we didn't use a graph database after the trial cost two weeks.`;
    await t.as(ana)
      .post("/v1/memories", { content: facts.session, kind: "context", session_id: session.id })
      .expect(201);
    await t.as(ana).put(`/v1/sessions/${session.id}/grants`, { email: sam.email, role: "reader" }).expect(200);
    const other = (await t.as(ana).post("/v1/sessions", { source: "note", title: "not shared" }).expect(201)).body.data;
    facts.unsharedSession = `Unshared session (${tag}): we didn't use a graph database vendor, pricing.`;
    await t.as(ana)
      .post("/v1/memories", { content: facts.unsharedSession, kind: "context", session_id: other.id })
      .expect(201);

    // An org space: Sam is a member of Ana's org, Eve is not.
    const org = (await t.as(ana).post("/v1/orgs", { slug: t.tag("acme").toLowerCase(), name: "Acme" }).expect(201)).body.data;
    await pool.query(
      "insert into org_members (org_id, user_id, role) values ($1, $2, 'member') on conflict do nothing",
      [org.id, sam.user.id],
    );
    orgSpace = (
      await t.as(ana).post("/v1/projects", { name: "Acme platform", visibility: "org", org_id: org.id }).expect(201)
    ).body.data.id;
    facts.org = `Org decision (${tag}): the platform didn't use a graph database either.`;
    await t.as(ana).post("/v1/memories", { content: facts.org, kind: "decision", project_id: orgSpace }).expect(201);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await pool?.end();
  });

  const query = "why didn't we use a graph database";

  it("REST recall: the teammate gets the shared, session and org facts; never Ana's private ones", async () => {
    const seen = await recall(sam, query);
    expect(seen).toEqual(expect.arrayContaining([facts.shared, facts.session, facts.org]));
    expect(seen).not.toContain(facts.personal);
    expect(seen).not.toContain(facts.sharedPrivate);
    expect(seen).not.toContain(facts.unsharedSession);
  });

  it("REST recall: the owner gets everything of hers", async () => {
    const seen = await recall(ana, query);
    expect(seen).toEqual(
      expect.arrayContaining([facts.shared, facts.sharedPrivate, facts.personal, facts.session, facts.org, facts.unsharedSession]),
    );
  });

  it("REST recall: the stranger gets none of it", async () => {
    const seen = await recall(eve, query);
    for (const fact of Object.values(facts)) expect(seen).not.toContain(fact);
  });

  it("MCP kt_recall with no project: the teammate gets Ana's fact, the stranger does not", async () => {
    const samText = await mcpText(sam, "kt_recall", { query });
    expect(samText).toContain(facts.shared);
    expect(samText).toContain(facts.session);
    expect(samText).not.toContain(facts.personal);
    expect(samText).not.toContain(facts.sharedPrivate);

    const eveText = await mcpText(eve, "kt_recall", { query });
    for (const fact of Object.values(facts)) expect(eveText).not.toContain(fact);
  });

  it("search with no space searches every readable space (REST and MCP), not an error", async () => {
    const seen = await search(sam, "graph database");
    expect(seen).toEqual(expect.arrayContaining([facts.shared, facts.session, facts.org]));
    expect(seen).not.toContain(facts.personal);
    expect(seen).not.toContain(facts.sharedPrivate);

    const samText = await mcpText(sam, "kt_search_memories", { query: "graph database" });
    expect(samText).toContain(facts.shared);

    const eveSeen = await search(eve, "graph database");
    for (const fact of Object.values(facts)) expect(eveSeen).not.toContain(fact);
    const eveText = await mcpText(eve, "kt_search_memories", { query: "graph database" });
    for (const fact of Object.values(facts)) expect(eveText).not.toContain(fact);
  });

  it("naming a space the caller cannot read is still a 404 (#78)", async () => {
    await t.as(eve).post("/v1/memories/recall", { query, project_id: team }).expect(404);
    await t.as(eve)
      .post("/v1/memories/search", { query, filters: { project_ids: [team] } })
      .expect(404);
    const eveTeamId = await t.space(eve, "Eve's own");
    await t.as(eve)
      .post("/v1/memories/search", { query, filters: { project_ids: [eveTeamId, orgSpace] } })
      .expect(404);
  });

  it("a named space still narrows recall to that space", async () => {
    const seen = await recall(sam, query, { project_id: team });
    expect(seen).toContain(facts.shared);
    expect(seen).not.toContain(facts.org);
  });

  it("archived facts leave recall", async () => {
    const tag = t.tag("archive");
    const content = `Archived graph database idea (${tag}).`;
    const saved = (await t.as(ana).post("/v1/memories", { content, kind: "note", project_id: team }).expect(201)).body.data;
    expect(await recall(sam, `graph database ${tag}`)).toContain(content);
    await t.as(ana).delete(`/v1/memories/${saved.id}`).expect(200);
    expect(await recall(sam, `graph database ${tag}`)).not.toContain(content);
    expect(await recall(ana, `graph database ${tag}`)).not.toContain(content);
  });
});
