/**
 * Skills, end to end: the REAL AppModule (no SUPABASE_* variables) over HTTP
 * against a real Postgres (`describeIfDb` — skipped when DATABASE_URL is
 * unset). People are created through /v1/auth/signup, so every access rule is
 * exercised with the credentials a client would actually hold.
 *
 * Covers: the starter skill every account gets; create from a title alone;
 * the 422 folder errors over HTTP; versions (n+1 on every save, 409 on a stale
 * base_version, restore = a new version); the access matrix (owner / space
 * editor / space reader / skill-grant reader / stranger) across list, get,
 * put, grants, delete; share by email, known and pending → converted at
 * sign-up; run counting; the MCP tools over a real in-memory MCP round-trip
 * and their presence in tools/list.
 */
import { randomUUID } from "node:crypto";

import { RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";

import type { ActorContext } from "@openkt/core-context";

import { McpServerFactoryService } from "../../apps/server/src/modules/mcp/services/mcp-server-factory.service";
import { SKILL_LIMITS } from "../../apps/server/src/modules/skills/services/skill-files";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const PASSWORD = "plum-Tractor-91";
const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@skills.test`;
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
const SHARPEN = skillMd(
  "sharpen-message",
  "Rewrite a marketing draft in our voice. Use when someone shares launch copy.",
  "# Sharpen a marketing message\n\nRewrite the draft so it sounds like us.\n",
);
const VOICE = "# Voice\n\nShort sentences. One claim per message.\n";

type Person = { token: string; user: { id: string; email: string; display_name: string }; email: string };

function actorContextFor(userId: string, email: string): ActorContext {
  return {
    principal: { type: "user", userId, email, displayName: null, authSource: "mcp-token", tokenId: null, serviceName: null },
    request: {
      requestId: "skills-e2e",
      ip: "127.0.0.1",
      userAgent: "jest",
      referer: null,
      origin: null,
      sessionId: null,
      surface: "mcp",
      actorKind: "agent",
    },
    sb: new Proxy({}, { get() { throw new Error("unexpected Supabase access"); } }) as ActorContext["sb"],
    admin: () => { throw new Error("unexpected Supabase admin access"); },
  };
}

async function bootApp(): Promise<NestExpressApplication> {
  for (const key of SUPABASE_KEYS) delete process.env[key];
  process.env.OPENKT_MEMORY_ENGINE = "local";
  const { AppModule } = await import("../../apps/server/src/app.module");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.set("trust proxy", true);
  // main.ts raises the JSON limit the same way; a skill may be 1 MB of text.
  app.useBodyParser("json", { limit: "3mb" });
  app.setGlobalPrefix("v1", { exclude: [{ path: "mcp", method: RequestMethod.ALL }] });
  await app.init();
  return app;
}

describeIfDb("Skills (e2e)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const as = (p: Person) => ({
    get: (path: string) => http().get(path).set(bearer(p.token)),
    post: (path: string, body: unknown = {}) => http().post(path).set(bearer(p.token)).send(body as object),
    put: (path: string, body: unknown) => http().put(path).set(bearer(p.token)).send(body as object),
    patch: (path: string, body: unknown) => http().patch(path).set(bearer(p.token)).send(body as object),
    delete: (path: string) => http().delete(path).set(bearer(p.token)),
  });

  async function signup(label: string, displayName = `${label} Person`, email = freshEmail(label)): Promise<Person> {
    const res = await http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: PASSWORD, display_name: displayName })
      .expect(201);
    return { token: res.body.data.token, user: res.body.data.user, email };
  }

  async function createSpace(p: Person, name = "Marketing"): Promise<string> {
    const res = await as(p).post("/v1/projects", { slug: `space-${randomUUID().slice(0, 8)}`, name, visibility: "personal" });
    if (res.status >= 300) throw new Error(`create space: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.id as string;
  }

  async function createSkill(p: Person, body: Record<string, unknown>) {
    const res = await as(p).post("/v1/skills", body);
    if (res.status !== 201) throw new Error(`create skill: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data as { id: string; slug: string; title: string; current_version: number; files: { path: string; content: string }[] };
  }

  beforeAll(async () => {
    for (const key of [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE"]) savedEnv[key] = process.env[key];
    pool = new Pool({ connectionString: DATABASE_URL });
    app = await bootApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool.query(`delete from login_attempts where email like $1 or email is null`, [`%-${run}-%@skills.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a new account starts with one personal skill, 'How to use OpenKT', that opens with its files", async () => {
    const ana = await signup("ana", "Ana Lima");
    const list = await as(ana).get("/v1/skills").expect(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({
        slug: "how-to-use-openkt",
        title: "How to use OpenKT",
        project_id: null,
        space_name: null,
        owner: { id: ana.user.id, display_name: "Ana Lima" },
        current_version: 1,
        run_count_30d: 0,
        my_role: "owner",
      }),
    ]);
    expect(list.body.data[0].description).toMatch(/OpenKT/);

    const detail = await as(ana).get(`/v1/skills/${list.body.data[0].id}`).expect(200);
    expect(detail.body.data.files).toEqual([
      { path: "SKILL.md", content: expect.stringContaining("name: how-to-use-openkt"), bytes: expect.any(Number) },
    ]);
    expect(detail.body.data.versions).toEqual([
      { version: 1, change_note: "Starter skill", created_by: { id: ana.user.id, display_name: "Ana Lima" }, created_at: expect.any(String) },
    ]);
    // It is only Ana's.
    const other = await signup("other");
    await as(other).get(`/v1/skills/${list.body.data[0].id}`).expect(404);
  });

  it("creating from a title alone writes a starter SKILL.md; a second one with the same title gets a free name", async () => {
    const ana = await signup("ana");
    const first = await createSkill(ana, { title: "Sharpen a marketing message" });
    expect(first).toMatchObject({ slug: "sharpen-a-marketing-message", title: "Sharpen a marketing message", current_version: 1 });
    expect(first.files[0].content).toMatch(/^---\nname: sharpen-a-marketing-message\ndescription: /);
    expect(first.files[0].content).toContain("# Sharpen a marketing message");

    const second = await createSkill(ana, { title: "Sharpen a marketing message" });
    expect(second.slug).toBe("sharpen-a-marketing-message-2");

    // With files given, the name comes from the frontmatter — and a clash is a 409.
    const clash = await as(ana).post("/v1/skills", { title: "Again", skill_md: first.files[0].content }).expect(409);
    expect(clash.body.error.code).toBe("slug_taken");
  });

  it("folder problems are 422s with a code that says what is wrong", async () => {
    const ana = await signup("ana");
    const cases: [string, Record<string, unknown>, string][] = [
      ["no frontmatter", { title: "x", skill_md: "# just markdown" }, "invalid_frontmatter"],
      ["bad name", { title: "x", skill_md: skillMd("Bad Name", "d", "") }, "invalid_frontmatter"],
      ["no SKILL.md", { title: "x", files: [{ path: "README.md", content: "hi" }] }, "missing_skill_md"],
      ["escaping path", { title: "x", files: [{ path: "SKILL.md", content: SHARPEN }, { path: "../x.md", content: "" }] }, "bad_path"],
      ["absolute path", { title: "x", files: [{ path: "SKILL.md", content: SHARPEN }, { path: "/etc/x", content: "" }] }, "bad_path"],
      [
        "too many files",
        { title: "x", files: [{ path: "SKILL.md", content: SHARPEN }, ...Array.from({ length: 20 }, (_, i) => ({ path: `r/${i}.md`, content: "" }))] },
        "too_many_files",
      ],
      [
        "file too large",
        { title: "x", files: [{ path: "SKILL.md", content: SHARPEN }, { path: "big.md", content: "x".repeat(SKILL_LIMITS.maxFileBytes + 1) }] },
        "file_too_large",
      ],
    ];
    for (const [label, body, code] of cases) {
      const res = await as(ana).post("/v1/skills", body);
      expect([label, res.status, res.body.error?.code]).toEqual([label, 422, code]);
      expect(res.body.error.message).toBeTruthy();
    }
    // Shape errors stay 400.
    await as(ana).post("/v1/skills", { skill_md: SHARPEN }).expect(400);
    await as(ana).post("/v1/skills", { title: "x", files: [], skill_md: SHARPEN }).expect(400);
    // Nothing was created by any of that.
    const list = await as(ana).get("/v1/skills").expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it("every save is a new version; a stale base_version is a 409; restoring copies an old version forward", async () => {
    const ana = await signup("ana", "Ana");
    const skill = await createSkill(ana, {
      title: "Sharpen a marketing message",
      files: [{ path: "SKILL.md", content: SHARPEN }, { path: "references/voice.md", content: VOICE }],
      change_note: "first draft",
    });
    expect(skill.files.map((f) => f.path)).toEqual(["SKILL.md", "references/voice.md"]);

    const v2md = skillMd("sharpen-message", "Rewrite a draft in our voice, under 60 words.", "# Sharpen it\n\nShorter.\n");
    const v2 = await as(ana)
      .put(`/v1/skills/${skill.id}`, { files: [{ path: "SKILL.md", content: v2md }], change_note: "shorter word limit", base_version: 1 })
      .expect(200);
    expect(v2.body.data).toMatchObject({
      current_version: 2,
      // Title from the new heading, description from the new frontmatter.
      title: "Sharpen it",
      description: "Rewrite a draft in our voice, under 60 words.",
      files: [{ path: "SKILL.md", content: v2md, bytes: Buffer.byteLength(v2md) }],
    });
    expect(v2.body.data.versions.map((v: { version: number; change_note: string }) => [v.version, v.change_note])).toEqual([
      [2, "shorter word limit"],
      [1, "first draft"],
    ]);

    // Someone saving from the old version loses, and is told why.
    const stale = await as(ana)
      .put(`/v1/skills/${skill.id}`, { files: [{ path: "SKILL.md", content: SHARPEN }], base_version: 1 })
      .expect(409);
    expect(stale.body.error.code).toBe("version_conflict");
    // An explicit title wins over the heading.
    const v3 = await as(ana)
      .put(`/v1/skills/${skill.id}`, { files: [{ path: "SKILL.md", content: v2md }], title: "Sharpen a message", base_version: 2 })
      .expect(200);
    expect(v3.body.data).toMatchObject({ current_version: 3, title: "Sharpen a message" });

    // Old versions stay readable, verbatim.
    const one = await as(ana).get(`/v1/skills/${skill.id}/versions/1`).expect(200);
    expect(one.body.data).toMatchObject({
      skill_id: skill.id,
      version: 1,
      change_note: "first draft",
      created_by: { id: ana.user.id, display_name: "Ana" },
      files: [{ path: "SKILL.md", content: SHARPEN, bytes: expect.any(Number) }, { path: "references/voice.md", content: VOICE, bytes: expect.any(Number) }],
    });
    await as(ana).get(`/v1/skills/${skill.id}/versions/9`).expect(404);

    // Restore = version 4 with version 1's files; history is untouched. The
    // card is re-derived from the restored SKILL.md, so v1's heading is back.
    const restored = await as(ana).post(`/v1/skills/${skill.id}/versions/1/restore`).expect(200);
    expect(restored.body.data).toMatchObject({
      current_version: 4,
      title: "Sharpen a marketing message",
      description: "Rewrite a marketing draft in our voice. Use when someone shares launch copy.",
    });
    expect(restored.body.data.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/voice.md"]);
    expect(restored.body.data.versions[0]).toMatchObject({ version: 4, change_note: "Restored v1" });
    expect(restored.body.data.versions).toHaveLength(4);

    const exported = await as(ana).get(`/v1/skills/${skill.id}/export`).expect(200);
    expect(exported.body.data).toEqual({ slug: "sharpen-message", version: 4, files: restored.body.data.files });
  });

  describe("who can do what", () => {
    let owner: Person, spaceEditor: Person, spaceReader: Person, skillReader: Person, stranger: Person;
    let spaceId: string;
    let skillId: string;

    beforeAll(async () => {
      [owner, spaceEditor, spaceReader, skillReader, stranger] = await Promise.all([
        signup("owner", "Olga Owner"),
        signup("editor", "Eddie Editor"),
        signup("reader", "Rita Reader"),
        signup("granted", "Gus Granted"),
        signup("stranger", "Sam Stranger"),
      ]);
      spaceId = await createSpace(owner, "Marketing");
      await as(owner).put(`/v1/projects/${spaceId}/grants`, { email: spaceEditor.email, role: "editor" }).expect(200);
      await as(owner).put(`/v1/projects/${spaceId}/grants`, { email: spaceReader.email, role: "reader" }).expect(200);
      skillId = (
        await createSkill(owner, {
          title: "Sharpen a marketing message",
          project_id: spaceId,
          files: [{ path: "SKILL.md", content: SHARPEN }, { path: "references/voice.md", content: VOICE }],
        })
      ).id;
      await as(owner).put(`/v1/skills/${skillId}/grants`, { email: skillReader.email, role: "reader" }).expect(200);
    }, 60_000);

    it("list: the owner, the space's people and the grantee see it with their role; a stranger does not", async () => {
      const roles: Record<string, string> = {};
      for (const [who, p] of [["owner", owner], ["spaceEditor", spaceEditor], ["spaceReader", spaceReader], ["skillReader", skillReader], ["stranger", stranger]] as const) {
        const res = await as(p).get("/v1/skills").expect(200);
        const hit = (res.body.data as { id: string; my_role: string; space_name: string | null }[]).find((s) => s.id === skillId);
        roles[who] = hit ? `${hit.my_role}/${hit.space_name}` : "-";
      }
      expect(roles).toEqual({
        owner: "owner/Marketing",
        spaceEditor: "editor/Marketing",
        spaceReader: "reader/Marketing",
        // A grant on the skill alone does not open the space, so its name stays private.
        skillReader: "reader/null",
        stranger: "-",
      });
      // Filtered by space, by slug or a word, and the personal starter never leaks across people.
      const inSpace = await as(spaceReader).get(`/v1/skills?project_id=${spaceId}`).expect(200);
      expect(inSpace.body.data.map((s: { id: string }) => s.id)).toEqual([skillId]);
      await as(stranger).get(`/v1/skills?project_id=${spaceId}`).expect(404);
      const byWord = await as(owner).get("/v1/skills?q=MARKETING").expect(200);
      expect(byWord.body.data.map((s: { id: string }) => s.id)).toEqual([skillId]);
    });

    it("get: the same four can open it and read every file; the stranger gets 404", async () => {
      for (const [p, role] of [[owner, "owner"], [spaceEditor, "editor"], [spaceReader, "reader"], [skillReader, "reader"]] as const) {
        const res = await as(p).get(`/v1/skills/${skillId}`).expect(200);
        expect(res.body.data.my_role).toBe(role);
        expect(res.body.data.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/voice.md"]);
      }
      await as(stranger).get(`/v1/skills/${skillId}`).expect(404);
      await as(stranger).get(`/v1/skills/${skillId}/versions/1`).expect(404);
      await as(stranger).get(`/v1/skills/${skillId}/export`).expect(404);
      await http().get(`/v1/skills/${skillId}`).expect(401);
    });

    it("put: the space editor saves a new version; readers get 403; the stranger 404", async () => {
      const body = { files: [{ path: "SKILL.md", content: SHARPEN }], change_note: "by the editor", base_version: 1 };
      const saved = await as(spaceEditor).put(`/v1/skills/${skillId}`, body).expect(200);
      expect(saved.body.data.current_version).toBe(2);
      expect(saved.body.data.versions[0].created_by).toEqual({ id: spaceEditor.user.id, display_name: "Eddie Editor" });

      const next = { ...body, base_version: 2 };
      expect((await as(spaceReader).put(`/v1/skills/${skillId}`, next)).status).toBe(403);
      expect((await as(skillReader).put(`/v1/skills/${skillId}`, next)).status).toBe(403);
      expect((await as(stranger).put(`/v1/skills/${skillId}`, next)).status).toBe(404);
      expect((await as(spaceReader).post(`/v1/skills/${skillId}/versions/1/restore`)).status).toBe(403);
      expect((await as(stranger).post(`/v1/skills/${skillId}/versions/1/restore`)).status).toBe(404);
      // Readers can still see that version 2 exists.
      const seen = await as(skillReader).get(`/v1/skills/${skillId}`).expect(200);
      expect(seen.body.data.current_version).toBe(2);
    });

    it("grants: only the owner manages them; editors and readers get 403 without seeing emails; strangers 404", async () => {
      const list = await as(owner).get(`/v1/skills/${skillId}/grants`).expect(200);
      expect(list.body.data).toEqual([
        expect.objectContaining({ resource_type: "skill", resource_id: skillId, pending: false, role: "reader", subject: { id: skillReader.user.id, email: skillReader.email, display_name: "Gus Granted" } }),
      ]);
      for (const p of [spaceEditor, spaceReader, skillReader]) {
        const res = await as(p).get(`/v1/skills/${skillId}/grants`).expect(403);
        expect(JSON.stringify(res.body)).not.toContain(skillReader.email);
        await as(p).put(`/v1/skills/${skillId}/grants`, { email: stranger.email, role: "reader" }).expect(403);
        await as(p).delete(`/v1/skills/${skillId}/grants/${skillReader.user.id}`).expect(403);
      }
      await as(stranger).get(`/v1/skills/${skillId}/grants`).expect(404);
      await as(stranger).put(`/v1/skills/${skillId}/grants`, { email: stranger.email, role: "reader" }).expect(404);

      // A skill-level editor can save, and still cannot manage the list.
      await as(owner).put(`/v1/skills/${skillId}/grants`, { email: stranger.email, role: "editor" }).expect(200);
      const asEditor = await as(stranger).get(`/v1/skills/${skillId}`).expect(200);
      expect(asEditor.body.data.my_role).toBe("editor");
      await as(stranger).get(`/v1/skills/${skillId}/grants`).expect(403);
      const revoked = await as(owner).delete(`/v1/skills/${skillId}/grants/${stranger.user.id}`).expect(200);
      expect(revoked.body.data).toEqual({ revoked: true });
      await as(stranger).get(`/v1/skills/${skillId}`).expect(404);
    });

    it("archive and move: editors may; archived skills leave the list until asked for; delete is the owner's alone", async () => {
      const archived = await as(spaceEditor).patch(`/v1/skills/${skillId}`, { archived: true }).expect(200);
      expect(archived.body.data.archived).toBe(true);
      const list = await as(owner).get("/v1/skills").expect(200);
      expect(list.body.data.some((s: { id: string }) => s.id === skillId)).toBe(false);
      const archivedList = await as(owner).get("/v1/skills?archived=true").expect(200);
      expect(archivedList.body.data.map((s: { id: string }) => s.id)).toEqual([skillId]);
      await as(spaceReader).patch(`/v1/skills/${skillId}`, { archived: false }).expect(403);
      await as(owner).patch(`/v1/skills/${skillId}`, { archived: false }).expect(200);

      // Moving it into a space the mover cannot write to is refused.
      const ownersOtherSpace = await createSpace(owner, "Sales");
      await as(spaceEditor).patch(`/v1/skills/${skillId}`, { project_id: ownersOtherSpace }).expect(404);
      const moved = await as(owner).patch(`/v1/skills/${skillId}`, { project_id: ownersOtherSpace }).expect(200);
      expect(moved.body.data).toMatchObject({ project_id: ownersOtherSpace, space_name: "Sales" });
      // The Marketing people lost it; the skill grantee still has it.
      await as(spaceEditor).get(`/v1/skills/${skillId}`).expect(404);
      await as(skillReader).get(`/v1/skills/${skillId}`).expect(200);
      await as(owner).patch(`/v1/skills/${skillId}`, { project_id: spaceId }).expect(200);

      await as(spaceEditor).delete(`/v1/skills/${skillId}`).expect(403);
      await as(stranger).delete(`/v1/skills/${skillId}`).expect(404);
      await as(owner).delete(`/v1/skills/${skillId}`).expect(200);
      await as(owner).get(`/v1/skills/${skillId}`).expect(404);
      const rows = await pool.query(`select count(*)::int as n from skill_versions where skill_id = $1`, [skillId]);
      expect(rows.rows[0].n).toBe(0);
      const grants = await pool.query(`select count(*)::int as n from grants where resource_type = 'skill' and resource_id = $1`, [skillId]);
      expect(grants.rows[0].n).toBe(0);
    });
  });

  it("share by email: a known email is granted now; an unknown one waits and converts when that email signs up", async () => {
    const owner = await signup("owner");
    const mate = await signup("mate", "Mia Mate");
    const skill = await createSkill(owner, { title: "Cut a release", skill_md: skillMd("cut-a-release", "How we ship.", "# Cut a release\n") });

    const known = await as(owner).put(`/v1/skills/${skill.id}/grants`, { email: mate.email.toUpperCase(), role: "editor" }).expect(200);
    expect(known.body.data).toMatchObject({ pending: false, resource_type: "skill", subject_id: mate.user.id, role: "editor", subject: { email: mate.email } });
    expect((await as(mate).get(`/v1/skills/${skill.id}`).expect(200)).body.data.my_role).toBe("editor");

    const lateEmail = freshEmail("late");
    const pending = await as(owner).put(`/v1/skills/${skill.id}/grants`, { email: lateEmail, role: "reader" }).expect(200);
    expect(pending.body.data).toMatchObject({ pending: true, resource_type: "skill", email: lateEmail, role: "reader" });
    let list = await as(owner).get(`/v1/skills/${skill.id}/grants`).expect(200);
    expect(list.body.data).toHaveLength(2);

    const late = await signup("late", "Lata Late", lateEmail);
    list = await as(owner).get(`/v1/skills/${skill.id}/grants`).expect(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({ pending: false, subject_id: mate.user.id, role: "editor" }),
      expect.objectContaining({ pending: false, subject_id: late.user.id, role: "reader", subject: { id: late.user.id, email: lateEmail, display_name: "Lata Late" } }),
    ]);
    const lateList = await as(late).get("/v1/skills").expect(200);
    expect(lateList.body.data.map((s: { id: string; my_role: string }) => [s.id, s.my_role])).toContainEqual([skill.id, "reader"]);

    // Sharing with yourself is refused; a pending share can be withdrawn by its own id.
    await as(owner).put(`/v1/skills/${skill.id}/grants`, { email: owner.email, role: "reader" }).expect(400);
    const withdrawn = await as(owner).put(`/v1/skills/${skill.id}/grants`, { email: freshEmail("never"), role: "reader" }).expect(200);
    expect((await as(owner).delete(`/v1/skills/${skill.id}/grants/${withdrawn.body.data.id}`).expect(200)).body.data).toEqual({ revoked: true });
  });

  it("runs: each recorded use counts, and the caller gets the current files back", async () => {
    const owner = await signup("owner");
    const reader = await signup("reader");
    const skill = await createSkill(owner, { title: "Cut a release", skill_md: skillMd("cut-a-release", "How we ship.", "# Cut a release\n") });
    await as(owner).put(`/v1/skills/${skill.id}/grants`, { email: reader.email, role: "reader" }).expect(200);

    const first = await as(reader).post(`/v1/skills/${skill.id}/runs`, { surface: "app" }).expect(200);
    expect(first.body.data).toMatchObject({ version: 1, skill: { id: skill.id, run_count: 1, run_count_30d: 1 } });
    expect(first.body.data.files[0]).toMatchObject({ path: "SKILL.md", content: expect.stringContaining("cut-a-release") });
    await as(owner).post(`/v1/skills/${skill.id}/runs`).expect(200);
    await as(owner).post(`/v1/skills/${skill.id}/runs`, { surface: "nope" }).expect(400);
    await as(await signup("stranger")).post(`/v1/skills/${skill.id}/runs`, { surface: "api" }).expect(404);

    const list = await as(owner).get("/v1/skills").expect(200);
    expect(list.body.data.find((s: { id: string }) => s.id === skill.id)).toMatchObject({ run_count: 2, run_count_30d: 2 });
    const runs = await pool.query(`select surface, user_id from skill_runs where skill_id = $1 order by created_at`, [skill.id]);
    expect(runs.rows).toEqual([{ surface: "app", user_id: reader.user.id }, { surface: "api", user_id: owner.user.id }]);
  });

  describe("MCP tools", () => {
    let owner: Person;
    let reader: Person;
    let spaceId: string;

    const mcpFor = async (p: Person) => {
      const factory = app.get(McpServerFactoryService);
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const server = await factory.build(actorContextFor(p.user.id, p.email));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "skills-e2e", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        return { text, structured: result.structuredContent as Record<string, unknown> | undefined, isError: result.isError === true };
      };
      return { client, server, call, close: async () => { await client.close(); await server.close(); } };
    };

    beforeAll(async () => {
      [owner, reader] = await Promise.all([signup("owner", "Olga Owner"), signup("reader", "Rita Reader")]);
      spaceId = await createSpace(owner, "Marketing");
      await as(owner).put(`/v1/projects/${spaceId}/grants`, { email: reader.email, role: "reader" }).expect(200);
    }, 60_000);

    it("tools/list over HTTP includes the three skill tools, with titles and annotations", async () => {
      const res = await http()
        .post("/mcp")
        .set(bearer(owner.token))
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        .expect(200);
      const payload = res.text.startsWith("{") ? JSON.parse(res.text) : JSON.parse(res.text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
      const tools = payload.result.tools as { name: string; title?: string; annotations?: { readOnlyHint?: boolean } }[];
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.kt_list_skills).toMatchObject({ title: "List the team's skills", annotations: { readOnlyHint: true } });
      expect(byName.kt_get_skill).toMatchObject({ title: "Read a skill", annotations: { readOnlyHint: false } });
      expect(byName.kt_save_skill).toMatchObject({ title: "Save a skill", annotations: { readOnlyHint: false } });
      for (const t of [byName.kt_list_skills, byName.kt_get_skill, byName.kt_save_skill]) {
        expect(Buffer.byteLength((t as { description?: string }).description ?? "")).toBeLessThanOrEqual(2048);
      }
    });

    it("kt_save_skill creates in a space, kt_list_skills lists it, kt_get_skill returns it in full and counts a run", async () => {
      const mcp = await mcpFor(owner);
      try {
        const saved = await mcp.call("kt_save_skill", { title: "Sharpen a marketing message", skill_md: SHARPEN, project: spaceId, change_note: "from a tool" });
        expect(saved.isError).toBe(false);
        expect(saved.text).toMatch(/Saved "Sharpen a marketing message" \(sharpen-message\) as version 1 — Marketing/);
        const skill = (saved.structured as { skill: { id: string; current_version: number } }).skill;
        expect(skill.current_version).toBe(1);

        // Add a reference file over REST; the tool keeps it on the next save.
        await as(owner).put(`/v1/skills/${skill.id}`, { files: [{ path: "SKILL.md", content: SHARPEN }, { path: "references/voice.md", content: VOICE }], base_version: 1 }).expect(200);

        const listed = await mcp.call("kt_list_skills", { project: spaceId });
        expect(listed.text).toMatch(/^1\. Sharpen a marketing message \(sharpen-message\) — Rewrite a marketing draft in our voice\. Use when someone shares launch copy\. — Marketing/);
        expect(listed.structured).toMatchObject({ count: 1, skills: [{ id: skill.id, my_role: "owner" }] });
        const all = await mcp.call("kt_list_skills", {});
        expect((all.structured as { count: number }).count).toBe(2); // + the starter skill

        const got = await mcp.call("kt_get_skill", { skill: "sharpen-message" });
        expect(got.isError).toBe(false);
        expect(got.text.startsWith("---\nname: sharpen-message")).toBe(true);
        expect(got.text).toContain("\n\n--- references/voice.md ---\n# Voice");
        expect(got.structured).toMatchObject({ version: 2, skill: { id: skill.id, run_count: 1 } });
        const byId = await mcp.call("kt_get_skill", { skill: skill.id });
        expect(byId.text).toBe(got.text);
        const runs = await pool.query(`select surface from skill_runs where skill_id = $1`, [skill.id]);
        expect(runs.rows).toEqual([{ surface: "mcp" }, { surface: "mcp" }]);

        const updated = await mcp.call("kt_save_skill", { title: "Sharpen a marketing message", skill: "sharpen-message", skill_md: SHARPEN.replace("Rewrite the draft", "Rewrite the whole draft"), change_note: "clearer" });
        expect(updated.text).toMatch(/as version 3/);
        const detail = await as(owner).get(`/v1/skills/${skill.id}`).expect(200);
        expect(detail.body.data.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/voice.md"]);
        expect(detail.body.data.versions[0]).toMatchObject({ version: 3, change_note: "clearer" });

        const bad = await mcp.call("kt_save_skill", { title: "Nope", skill_md: "# no frontmatter" });
        expect(bad.isError).toBe(true);
        expect(bad.text).toMatch(/frontmatter/);
        const missing = await mcp.call("kt_get_skill", { skill: "does-not-exist" });
        expect(missing.isError).toBe(true);
      } finally {
        await mcp.close();
      }
    });

    it("a space reader reads the skill over MCP but cannot save a new version; a stranger sees nothing", async () => {
      const mcp = await mcpFor(reader);
      try {
        const listed = await mcp.call("kt_list_skills", { project: spaceId });
        expect(listed.structured).toMatchObject({ count: 1, skills: [{ slug: "sharpen-message", my_role: "reader" }] });
        const got = await mcp.call("kt_get_skill", { skill: "sharpen-message", project: spaceId });
        expect(got.isError).toBe(false);
        expect(got.text).toContain("Rewrite the whole draft");
        const denied = await mcp.call("kt_save_skill", { title: "Sharpen a marketing message", skill: "sharpen-message", skill_md: SHARPEN });
        expect(denied.isError).toBe(true);
      } finally {
        await mcp.close();
      }
      const stranger = await mcpFor(await signup("stranger"));
      try {
        const listed = await stranger.call("kt_list_skills", { q: "sharpen" });
        expect(listed.structured).toMatchObject({ count: 0 });
        expect(listed.text).toMatch(/No skills yet/);
        expect((await stranger.call("kt_get_skill", { skill: "sharpen-message" })).isError).toBe(true);
      } finally {
        await stranger.close();
      }
    });
  });
});
