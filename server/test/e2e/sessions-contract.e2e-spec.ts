/**
 * Sessions per Spec 04, the parts clients rely on (prod gap audit #6–#9):
 *   - real sources: the tools the app and `packages/connect` connect
 *     (codex, cursor, gemini, windsurf, hermes, chatgpt, claude-ai, cowork…),
 *     not everything filed as `connector`;
 *   - `POST /v1/sessions` is idempotent on `(source, external_id)` per owner:
 *     the second call is 200 with the existing session;
 *   - `POST /v1/sessions/:id/turns` takes `{turns:[…]}` (≤ 200 turns, ≤ 1 MB)
 *     as well as one `{role, content}`;
 *   - appending to a closed session is 409 `session_closed`.
 * Real AppModule over HTTP, real Postgres (`describeIfDb`).
 */
import { HttpApp, type Person } from "./support/http-app";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const SOURCES = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "windsurf",
  "opencode",
  "vscode",
  "claude-desktop",
  "hermes",
  "chatgpt",
  "claude-ai",
  "claude",
  "cowork",
  "mcp",
  "voice",
  "screenshot",
  "meeting",
  "note",
  "connector",
];

describeIfDb("Sessions: sources, idempotent create, batched turns, closed sessions (e2e)", () => {
  const t = new HttpApp();
  let ana: Person;
  let bob: Person;

  beforeAll(async () => {
    await t.start();
    ana = await t.signup("ana-sessions", "Ana");
    bob = await t.signup("bob-sessions", "Bob");
  }, 60_000);

  afterAll(async () => {
    await t.stop();
  });

  describe("sources", () => {
    it.each(SOURCES)("POST /v1/sessions accepts source %s and keeps it", async (source) => {
      const res = await t.as(ana).post("/v1/sessions", { source, client: `${source}/1.0` }).expect(201);
      expect(res.body.data.source).toBe(source);
      const got = await t.as(ana).get(`/v1/sessions/${res.body.data.id}`).expect(200);
      expect(got.body.data.session.source).toBe(source);
    });

    it("an unknown source is a validation error", async () => {
      await t.as(ana).post("/v1/sessions", { source: "myspace" }).expect(400);
    });

    it("MCP kt_session_start takes the same sources", async () => {
      const result = await t.mcp(ana, "kt_session_start", { source: "codex", title: "codex run" });
      expect(result.isError).toBeFalsy();
      const session = result.structuredContent?.session ?? JSON.parse(result.content[0]!.text).session;
      expect(session.source).toBe("codex");
    });
  });

  describe("external_id idempotency", () => {
    it("the same (source, external_id) twice → 201 then 200 with the same session", async () => {
      const externalId = t.tag("codex-thread");
      const first = await t.as(ana)
        .post("/v1/sessions", { source: "codex", external_id: externalId, external_url: "https://example.test/t/1", title: "first" })
        .expect(201);
      const second = await t.as(ana)
        .post("/v1/sessions", { source: "codex", external_id: externalId, title: "second" })
        .expect(200);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.title).toBe("first");
      expect(first.body.data.external_id).toBe(externalId);
      expect(first.body.data.external_url).toBe("https://example.test/t/1");
    });

    it("concurrent creates with one external_id make one session", async () => {
      const externalId = t.tag("race");
      const results = await Promise.all(
        Array.from({ length: 5 }, () => t.as(ana).post("/v1/sessions", { source: "cursor", external_id: externalId })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    });

    it("another source, or another person, gets its own session", async () => {
      const externalId = t.tag("shared-id");
      const a = await t.as(ana).post("/v1/sessions", { source: "codex", external_id: externalId }).expect(201);
      const b = await t.as(ana).post("/v1/sessions", { source: "cursor", external_id: externalId }).expect(201);
      const c = await t.as(bob).post("/v1/sessions", { source: "codex", external_id: externalId }).expect(201);
      expect(new Set([a.body.data.id, b.body.data.id, c.body.data.id]).size).toBe(3);
    });

    it("without external_id every call is a new session", async () => {
      const a = await t.as(ana).post("/v1/sessions", { source: "note" }).expect(201);
      const b = await t.as(ana).post("/v1/sessions", { source: "note" }).expect(201);
      expect(a.body.data.id).not.toBe(b.body.data.id);
    });
  });

  describe("turns", () => {
    async function open(): Promise<string> {
      return (await t.as(ana).post("/v1/sessions", { source: "meeting" }).expect(201)).body.data.id;
    }

    it("the single form still works and returns the turn", async () => {
      const id = await open();
      const res = await t.as(ana).post(`/v1/sessions/${id}/turns`, { role: "user", content: "hello" }).expect(201);
      expect(res.body.data.seq).toBe(1);
      expect(res.body.data.content).toBe("hello");
    });

    it("{turns:[…]} appends them in order → {appended, next_seq}", async () => {
      const id = await open();
      await t.as(ana).post(`/v1/sessions/${id}/turns`, { role: "user", content: "first" }).expect(201);
      const res = await t.as(ana)
        .post(`/v1/sessions/${id}/turns`, {
          turns: [
            { role: "user", speaker: "Ana", content: "we pick Postgres", t0_ms: 0, t1_ms: 1500 },
            { role: "assistant", content: "noted" },
            { role: "user", speaker: "Bob", content: "agreed", t0_ms: 1500, t1_ms: 2100 },
          ],
        })
        .expect(201);
      expect(res.body.data).toEqual({ appended: 3, next_seq: 5 });

      const got = await t.as(ana).get(`/v1/sessions/${id}`).expect(200);
      const turns = got.body.data.turns as { seq: number; role: string; content: string; metadata: Record<string, unknown> }[];
      expect(turns.map((x) => [x.seq, x.role, x.content])).toEqual([
        [1, "user", "first"],
        [2, "user", "we pick Postgres"],
        [3, "assistant", "noted"],
        [4, "user", "agreed"],
      ]);
      expect(turns[1]!.metadata).toMatchObject({ speaker: "Ana", t0_ms: 0, t1_ms: 1500 });
    });

    it("more than 200 turns, or more than 1 MB, is refused and appends nothing", async () => {
      const id = await open();
      const many = Array.from({ length: 201 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
      await t.as(ana).post(`/v1/sessions/${id}/turns`, { turns: many }).expect(400);
      const big = Array.from({ length: 30 }, () => ({ role: "user", content: "x".repeat(40_000) }));
      const tooBig = await t.as(ana).post(`/v1/sessions/${id}/turns`, { turns: big });
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.error.code).toBe("payload_too_large");
      const got = await t.as(ana).get(`/v1/sessions/${id}`).expect(200);
      expect(got.body.data.turns).toEqual([]);
    });

    it("an empty batch or a bad turn is a validation error", async () => {
      const id = await open();
      await t.as(ana).post(`/v1/sessions/${id}/turns`, { turns: [] }).expect(400);
      await t.as(ana).post(`/v1/sessions/${id}/turns`, { turns: [{ role: "robot", content: "x" }] }).expect(400);
    });

    it("a secret in any turn refuses the whole batch", async () => {
      const id = await open();
      const res = await t.as(ana).post(`/v1/sessions/${id}/turns`, {
        turns: [
          { role: "user", content: "fine" },
          { role: "user", content: "my key is AKIAIOSFODNN7EXAMPLE and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
        ],
      });
      expect(res.status).toBe(422);
      const got = await t.as(ana).get(`/v1/sessions/${id}`).expect(200);
      expect(got.body.data.turns).toEqual([]);
    });

    it("appending to a closed session is 409 session_closed (single and batch)", async () => {
      const id = await open();
      await t.as(ana).post(`/v1/sessions/${id}/turns`, { role: "user", content: "before close" }).expect(201);
      await t.as(ana).post(`/v1/sessions/${id}/close`, { summary: "done" }).expect(200);
      const single = await t.as(ana).post(`/v1/sessions/${id}/turns`, { role: "user", content: "late" });
      expect(single.status).toBe(409);
      expect(single.body.error.code).toBe("session_closed");
      const batch = await t.as(ana).post(`/v1/sessions/${id}/turns`, { turns: [{ role: "user", content: "late" }] });
      expect(batch.status).toBe(409);
      expect(batch.body.error.code).toBe("session_closed");
      // Closing again is still fine.
      await t.as(ana).post(`/v1/sessions/${id}/close`, {}).expect(200);
    });

    it("someone who cannot write the session still gets 404, not 409", async () => {
      const id = await open();
      await t.as(ana).post(`/v1/sessions/${id}/close`, {}).expect(200);
      await t.as(bob).post(`/v1/sessions/${id}/turns`, { role: "user", content: "x" }).expect(404);
    });
  });
});
