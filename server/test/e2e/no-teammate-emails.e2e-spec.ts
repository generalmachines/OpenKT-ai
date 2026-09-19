/**
 * Another person's email never reaches a teammate. Spec 04: emails appear
 * only in a resource owner's grants list (and your own in `/v1/me`).
 * Everything a teammate reads — recall, search, fact lists, sessions, space
 * and org member lists, skills, the MCP tools, an invite preview — names
 * people by display name and id only. The test asserts that no `@` appears
 * in any of those payloads. Real AppModule over HTTP, real Postgres.
 */
import { Pool } from "pg";

import { HttpApp, type Person } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("No teammate-facing payload carries another person's email (e2e)", () => {
  const t = new HttpApp();
  let pool: Pool;
  let ana: Person;
  let sam: Person;
  let team: string;
  let orgSlug: string;
  let orgSpace: string;
  let sharedSession: string;
  let teamSession: string;
  let factId: string;
  let inviteToken: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await t.start();
    ana = await t.signup("ana-noemail", "Ana");
    sam = await t.signup("sam-noemail", "Sam");
    const tag = t.tag("noemail");

    team = await t.space(ana, "Hackathon team", sam, "editor");
    teamSession = (await t.as(ana).post("/v1/sessions", { source: "claude-code", project_id: team, title: "db" }).expect(201)).body.data.id;
    factId = (
      await t.as(ana)
        .post("/v1/memories", { content: `We dropped the graph database ${tag}.`, kind: "decision", project_id: team, session_id: teamSession })
        .expect(201)
    ).body.data.id;
    await t.as(sam).post("/v1/memories", { content: `Sam agrees on the graph database ${tag}.`, kind: "note", project_id: team }).expect(201);

    sharedSession = (await t.as(ana).post("/v1/sessions", { source: "note", title: "private call" }).expect(201)).body.data.id;
    await t.as(ana).post("/v1/memories", { content: `Graph database pricing call ${tag}.`, kind: "context", session_id: sharedSession }).expect(201);
    await t.as(ana).put(`/v1/sessions/${sharedSession}/grants`, { email: sam.email, role: "reader" }).expect(200);

    orgSlug = t.tag("acme").toLowerCase();
    const org = (await t.as(ana).post("/v1/orgs", { slug: orgSlug, name: "Acme" }).expect(201)).body.data;
    await pool.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [org.id, sam.user.id]);
    orgSpace = (await t.as(ana).post("/v1/projects", { name: "Acme platform", visibility: "org", org_id: org.id }).expect(201)).body.data.id;
    await t.as(ana).post("/v1/memories", { content: `Acme uses no graph database ${tag}.`, kind: "decision", project_id: orgSpace }).expect(201);
    inviteToken = (await t.as(ana).post("/v1/invites", { org_slug: orgSlug, is_open: true, max_uses: 5 }).expect(201)).body.data.token;

    await t.as(ana)
      .post("/v1/skills", {
        title: "Write a decision",
        project_id: team,
        skill_md: "---\nname: write-a-decision\ndescription: How we record a decision.\n---\nState it in one sentence.",
      })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await pool?.end();
  });

  const noEmail = (label: string, payload: unknown) => {
    const text = JSON.stringify(payload);
    if (text.includes("@")) throw new Error(`${label} carries an email: ${text.slice(Math.max(0, text.indexOf("@") - 60), text.indexOf("@") + 30)}`);
  };

  it("REST: recall, search, fact lists, sessions, members, skills", async () => {
    const q = "graph database";
    const reads: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ["recall (every space)", () => t.as(sam).post("/v1/memories/recall", { query: q, limit: 50 })],
      ["recall (one space)", () => t.as(sam).post("/v1/memories/recall", { query: q, project_id: team })],
      ["search", () => t.as(sam).post("/v1/memories/search", { query: q, limit: 50 })],
      ["a space's facts", () => t.as(sam).get(`/v1/memories?project_id=${team}`)],
      ["one fact", () => t.as(sam).get(`/v1/memories/${factId}`)],
      ["sessions shared with me", () => t.as(sam).get("/v1/sessions?shared=true")],
      ["sessions in a space", () => t.as(sam).get(`/v1/sessions?project_id=${team}`)],
      ["a shared session", () => t.as(sam).get(`/v1/sessions/${sharedSession}`)],
      ["a team session", () => t.as(sam).get(`/v1/sessions/${teamSession}`)],
      ["spaces", () => t.as(sam).get("/v1/projects")],
      ["a space", () => t.as(sam).get(`/v1/projects/${team}`)],
      ["space members", () => t.as(sam).get(`/v1/projects/${team}/members`)],
      ["org members", () => t.as(sam).get(`/v1/orgs/slug/${orgSlug}/members`)],
      ["skills", () => t.as(sam).get("/v1/skills")],
      ["invite preview (public)", () => t.http().get(`/v1/invites/preview/${inviteToken}`)],
    ];
    for (const [label, read] of reads) {
      const res = await read();
      expect([label, res.status]).toEqual([label, 200]);
      noEmail(label, res.body);
    }
    // They are not empty: Ana's facts and names are there.
    const recalled = (await t.as(sam).post("/v1/memories/recall", { query: q, limit: 50 })).body.data as Array<{ owner: { display_name: string } }>;
    expect(recalled.map((m) => m.owner.display_name)).toEqual(expect.arrayContaining(["Ana", "Sam"]));
    const members = (await t.as(sam).get(`/v1/orgs/slug/${orgSlug}/members`)).body.data.members as Array<{ display_name: string }>;
    expect(members.map((m) => m.display_name)).toEqual(expect.arrayContaining(["Ana", "Sam"]));
  });

  it("MCP: recall, search, spaces, brief, skills, session start in a shared space", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["kt_recall", { query: "graph database" }],
      ["kt_search_memories", { query: "graph database" }],
      ["kt_list_projects", {}],
      ["kt_project_brief", { project_id: team }],
      ["kt_list_skills", {}],
      ["kt_session_start", { project: team, title: "sam's session" }],
    ];
    for (const [tool, args] of calls) {
      const result = await t.mcp(sam, tool, args);
      expect([tool, result.isError ?? false]).toEqual([tool, false]);
      noEmail(tool, { text: result.content.filter((c) => c.type === "text"), structured: result.structuredContent });
    }
  });

  it("the owner's grants list still names people by email (the one place they appear)", async () => {
    const grants = await t.as(ana).get(`/v1/projects/${team}/grants`).expect(200);
    expect(JSON.stringify(grants.body)).toContain(sam.email);
    await t.as(sam).get(`/v1/projects/${team}/grants`).expect(403);
    const me = await t.as(sam).get("/v1/me").expect(200);
    expect(me.body.data.email).toBe(sam.email);
  });
});
