/**
 * Built-in accounts, end to end: the REAL AppModule booted with NO SUPABASE_*
 * variables, driven over HTTP against a real Postgres (`describeIfDb` — skipped
 * when DATABASE_URL is unset).
 *
 * Covers: boot without Supabase; signup → login → /v1/me → logout → token
 * rejected; duplicate email; weak passwords; the brute-force limits (failed
 * logins per email and per IP, sign-ups per IP — a venue behind one address
 * can all sign up; generic message); password change signing out other sessions;
 * Google sign-in (create, link by email, rejected tokens — "provider disabled"
 * needs a second boot and lives in built-in-accounts-google-off.e2e-spec.ts);
 * share by email (known email, unknown email → pending → converts at signup)
 * and who may see the emails on an access list.
 *
 * Google tokens are signed with a locally generated RSA key and the JWKS
 * fetcher is replaced through DI — no test touches the network.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";

import { GOOGLE_JWKS_FETCHER } from "../../apps/server/src/modules/accounts/services/google-id-token-verifier.service";
import { RATE_LIMIT_MESSAGE } from "../../apps/server/src/modules/accounts/services/login-attempts.service";
import type { JwksFetcher } from "../../apps/server/src/modules/auth/services/jwks-key-cache";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const GOOGLE_CLIENT_ID = "openkt-test.apps.googleusercontent.com";
const KID = "e2e-google-key";
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleJwks: JwksFetcher = async () => ({
  keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }],
  maxAgeMs: 3_600_000,
});

function googleToken(claims: Record<string, unknown>): string {
  return jwt.sign(
    {
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...claims,
    },
    googleKey.privateKey,
    { algorithm: "RS256", keyid: KID },
  );
}

const SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
// Per-IP limits small enough to reach in a test (production: 100 failed
// logins / 15 min, 300 sign-ups / hour). The per-email limit keeps its default.
const LIMITS = { OPENKT_AUTH_MAX_FAILED_LOGINS_PER_IP: "12", OPENKT_AUTH_MAX_SIGNUPS_PER_IP: "15" };
const PASSWORD = "plum-Tractor-91";

// Every test gets its own addresses, so reruns against one database never collide.
const run = randomUUID().slice(0, 8);
let counter = 0;
const freshEmail = (label: string) => `${label}-${run}-${++counter}@accounts.test`;
// A distinct client address per caller (the app trusts X-Forwarded-For in
// these tests), so one test's attempts never count against another's.
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++counter % 250}`;

async function bootApp(env: Record<string, string | undefined>): Promise<NestExpressApplication> {
  for (const key of SUPABASE_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Imported lazily so the module graph is built against the env set above.
  const { AppModule } = await import("../../apps/server/src/app.module");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GOOGLE_JWKS_FETCHER)
    .useValue(googleJwks)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.set("trust proxy", true);
  app.setGlobalPrefix("v1", { exclude: [{ path: "mcp", method: RequestMethod.ALL }] });
  await app.init();
  return app;
}

describeIfDb("Built-in accounts (e2e, no Supabase configured)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown, ip = freshIp()) =>
    http().post(path).set("X-Forwarded-For", ip).send(body as object);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signup(email: string, displayName = "Test Person", password = PASSWORD) {
    const res = await post("/v1/auth/signup", { email, password, display_name: displayName }).expect(201);
    return res.body.data as { token: string; expires_at: string; user: { id: string; email: string; display_name: string } };
  }

  beforeAll(async () => {
    for (const key of [...SUPABASE_KEYS, ...Object.keys(LIMITS), "OPENKT_GOOGLE_CLIENT_IDS", "OPENKT_MEMORY_ENGINE"]) savedEnv[key] = process.env[key];
    pool = new Pool({ connectionString: DATABASE_URL });
    app = await bootApp({ ...LIMITS, OPENKT_GOOGLE_CLIENT_IDS: `other.apps.googleusercontent.com, ${GOOGLE_CLIENT_ID}`, OPENKT_MEMORY_ENGINE: "local" });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    // Accounts stay (the audit log references them, and every run uses fresh
    // addresses); only the attempt counters are swept.
    await pool.query(`delete from login_attempts where email like $1 or email is null`, [`%-${run}-%@accounts.test`]);
    await pool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("boots with no SUPABASE_* variables and says which sign-in methods exist", async () => {
    for (const key of SUPABASE_KEYS) expect(process.env[key]).toBeUndefined();
    const res = await http().get("/v1/auth/providers").expect(200);
    // The first configured client id is the one a client should use.
    expect(res.body.data).toEqual({ password: true, google: { enabled: true, client_id: "other.apps.googleusercontent.com" } });
    await http().get("/v1/health").expect(200);
  });

  it("without Supabase, a bearer that is not an access token is a plain 401; Supabase routes are 404", async () => {
    await http().get("/v1/me").set(bearer("eyJhbGciOiJIUzI1NiJ9.e30.not-ours")).expect(401);
    await http().get("/v1/me").expect(401);
    const res = await post("/v1/auth/supabase/password", { email: "a@b.co", password: "whatever-123" }).expect(404);
    expect(res.body.error.code).toBe("provider_disabled");
  });

  it("signup → login → /v1/me → logout → the token is rejected", async () => {
    const email = freshEmail("ana");
    const created = await signup(email.toUpperCase(), "Ana Lima");
    expect(created.token).toMatch(/^okt_pat_[0-9a-f]{64}$/);
    expect(created.user).toEqual({ id: expect.any(String), email, display_name: "Ana Lima" });
    const days = (new Date(created.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);

    // The session IS an access token named after the client, read + write.
    const stored = await pool.query(`select name, scopes from personal_access_tokens where user_id = $1`, [created.user.id]);
    expect(stored.rows).toEqual([{ name: "session:desktop", scopes: ["read", "write"] }]);
    // The password is stored as a scrypt hash, never as typed.
    const cred = await pool.query(`select email, password_hash, email_verified from user_credentials where user_id = $1`, [created.user.id]);
    expect(cred.rows[0].email).toBe(email);
    expect(cred.rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(cred.rows[0].email_verified).toBe(false);
    // The personal space exists from the first second.
    const spaces = await pool.query(`select visibility from projects where owner_user_id = $1`, [created.user.id]);
    expect(spaces.rows).toEqual([{ visibility: "personal" }]);

    const login = await post("/v1/auth/login", { email, password: PASSWORD, client: "cli" }).expect(200);
    const session = login.body.data as typeof created;
    expect(session.user).toEqual(created.user);
    expect(session.token).not.toBe(created.token);

    const me = await http().get("/v1/me").set(bearer(session.token)).expect(200);
    expect(me.body.data).toMatchObject({ user_id: created.user.id, email, display_name: "Ana Lima" });

    await http().post("/v1/auth/logout").set(bearer(session.token)).expect(204);
    await http().get("/v1/me").set(bearer(session.token)).expect(401);
    // Logging out one session leaves the other alone.
    await http().get("/v1/me").set(bearer(created.token)).expect(200);
    await http().post("/v1/auth/logout").expect(401);
  });

  it("a session token works on the MCP endpoint too", async () => {
    const { token } = await signup(freshEmail("mcp"));
    const res = await http()
      .post("/mcp")
      .set(bearer(token))
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    expect(res.text).toContain("kt_recall");
  });

  it("duplicate email → 409 email_taken, whatever the case", async () => {
    const email = freshEmail("dup");
    await signup(email);
    const res = await post("/v1/auth/signup", { email: email.toUpperCase(), password: PASSWORD, display_name: "Again" }).expect(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("weak passwords are rejected with the reason", async () => {
    const email = freshEmail("weak");
    for (const [password, reason] of [
      ["short1234", /at least 10/],
      [email, /email/],
      ["Password123", /too common/],
      ["1234567890", /too common/],
    ] as const) {
      const res = await post("/v1/auth/signup", { email, password, display_name: "Weak" }).expect(400);
      expect(res.body.error.code).toBe("weak_password");
      expect(res.body.error.message).toMatch(reason);
    }
    await post("/v1/auth/signup", { email: "not-an-email", password: PASSWORD, display_name: "X" }).expect(400);
    await post("/v1/auth/signup", { email, password: PASSWORD }).expect(400); // display_name is required
    const rows = await pool.query(`select 1 from user_credentials where email = $1`, [email]);
    expect(rows.rowCount).toBe(0);
  });

  it("login failures all look the same: unknown email, wrong password, Google-only account", async () => {
    const email = freshEmail("same");
    await signup(email);
    const googleOnly = freshEmail("gonly");
    await post("/v1/auth/google", { id_token: googleToken({ sub: `sub-${googleOnly}`, email: googleOnly }) }).expect(200);

    const bodies = [];
    for (const attempt of [
      { email, password: "wrong-password-1" },
      { email: freshEmail("nobody"), password: PASSWORD },
      { email: googleOnly, password: PASSWORD },
    ]) {
      const res = await post("/v1/auth/login", attempt).expect(401);
      bodies.push({ code: res.body.error.code, message: res.body.error.message, details: res.body.error.details });
    }
    expect(bodies[0]).toEqual({ code: "invalid_credentials", message: "invalid email or password", details: null });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("rate limit per EMAIL: the 11th failed login in 15 minutes is refused, from any address, with a generic message", async () => {
    const email = freshEmail("limited");
    await signup(email); // a successful sign-up does not count against the email
    for (let i = 0; i < 10; i++) {
      await post("/v1/auth/login", { email, password: "wrong-password-1" }).expect(401); // failures 1..10, each from a new IP
    }
    const blocked = await post("/v1/auth/login", { email, password: "wrong-password-1" }).expect(429);
    expect(blocked.body.error.code).toBe("rate_limited");
    expect(blocked.body.error.message).toBe(RATE_LIMIT_MESSAGE);
    // Even the right password waits out the window — and the refusal reads the same.
    const right = await post("/v1/auth/login", { email, password: PASSWORD }).expect(429);
    expect(right.body.error.message).toBe(RATE_LIMIT_MESSAGE);

    // An email with no account trips the same limit with the same words: the
    // limiter cannot be used to learn who has an account.
    const ghost = freshEmail("ghost");
    for (let i = 0; i < 10; i++) await post("/v1/auth/login", { email: ghost, password: "wrong-password-1" }).expect(401);
    const ghostBlocked = await post("/v1/auth/login", { email: ghost, password: "wrong-password-1" }).expect(429);
    expect(ghostBlocked.body.error).toMatchObject({ code: "rate_limited", message: RATE_LIMIT_MESSAGE });
  });

  it("rate limit per IP: failed logins past OPENKT_AUTH_MAX_FAILED_LOGINS_PER_IP are refused, whatever the email", async () => {
    const ip = freshIp();
    for (let i = 0; i < 12; i++) {
      await post("/v1/auth/login", { email: freshEmail("spray"), password: "wrong-password-1" }, ip).expect(401);
    }
    const blocked = await post("/v1/auth/login", { email: freshEmail("spray"), password: "wrong-password-1" }, ip).expect(429);
    expect(blocked.body.error).toMatchObject({ code: "rate_limited", message: RATE_LIMIT_MESSAGE });
    // Sign-ups have their own budget: a newcomer on that address still gets in.
    await post("/v1/auth/signup", { email: freshEmail("spray"), password: PASSWORD, display_name: "S" }, ip).expect(201);
    // Someone else, elsewhere, is unaffected.
    await signup(freshEmail("elsewhere"));
  });

  it("a venue behind one address: every sign-up up to OPENKT_AUTH_MAX_SIGNUPS_PER_IP gets in, the next is refused", async () => {
    const venue = freshIp();
    const people: string[] = [];
    for (let i = 0; i < 15; i++) {
      const email = freshEmail("venue");
      await post("/v1/auth/signup", { email, password: PASSWORD, display_name: `Guest ${i}` }, venue).expect(201);
      people.push(email);
    }
    const refused = await post("/v1/auth/signup", { email: freshEmail("venue"), password: PASSWORD, display_name: "Late" }, venue).expect(429);
    expect(refused.body.error).toMatchObject({ code: "rate_limited", message: RATE_LIMIT_MESSAGE });
    // A 409 for a taken email counts as a sign-up too, so it cannot be used to probe past the limit.
    await post("/v1/auth/signup", { email: people[0], password: PASSWORD, display_name: "Again" }, venue).expect(429);
    // Sign-ups used none of the failed-login budget: everyone signs in from the same address.
    for (const email of people) await post("/v1/auth/login", { email, password: PASSWORD }, venue).expect(200);
    const rows = await pool.query(`select kind, count(*)::int as n from login_attempts where ip = $1 group by kind`, [venue]);
    expect(rows.rows).toEqual([{ kind: "signup", n: 15 }]);
  });

  it("successful logins are not counted: an office behind one address is not locked out", async () => {
    const ip = freshIp();
    const email = freshEmail("office");
    await signup(email);
    for (let i = 0; i < 12; i++) await post("/v1/auth/login", { email, password: PASSWORD }, ip).expect(200);
  });

  it("changing the password signs out every OTHER session and the old password stops working", async () => {
    const email = freshEmail("rotate");
    const first = await signup(email);
    const second = (await post("/v1/auth/login", { email, password: PASSWORD, client: "web" }).expect(200)).body.data;
    const third = (await post("/v1/auth/login", { email, password: PASSWORD, client: "cli" }).expect(200)).body.data;
    // A hand-made access token is not a session and must survive.
    const pat = await http().post("/v1/me/tokens").set(bearer(first.token)).send({ name: "ci-job" }).expect(200);

    const NEW_PASSWORD = "olive-Harbour-47";
    await http().post("/v1/auth/password").set(bearer(second.token))
      .send({ current_password: "wrong-password-1", new_password: NEW_PASSWORD }).expect(401);
    await http().post("/v1/auth/password").set(bearer(second.token))
      .send({ current_password: PASSWORD, new_password: "short" }).expect(400);
    await http().post("/v1/auth/password").send({ current_password: PASSWORD, new_password: NEW_PASSWORD }).expect(401);
    await http().post("/v1/auth/password").set(bearer(second.token))
      .send({ current_password: PASSWORD, new_password: NEW_PASSWORD }).expect(204);

    await http().get("/v1/me").set(bearer(second.token)).expect(200);
    await http().get("/v1/me").set(bearer(first.token)).expect(401);
    await http().get("/v1/me").set(bearer(third.token)).expect(401);
    await http().get("/v1/me").set(bearer(pat.body.data.token)).expect(200);

    await post("/v1/auth/login", { email, password: PASSWORD }).expect(401);
    await post("/v1/auth/login", { email, password: NEW_PASSWORD }).expect(200);
  });

  describe("Google sign-in", () => {
    it("a valid ID token creates the account (no password), its personal space, and a session", async () => {
      const email = freshEmail("gnew");
      const res = await post("/v1/auth/google", {
        id_token: googleToken({ sub: `sub-${email}`, email: email.toUpperCase(), name: "Gia New", picture: "https://example.com/g.png" }),
        client: "web",
      }).expect(200);
      expect(res.body.data.user).toEqual({ id: expect.any(String), email, display_name: "Gia New" });
      const userId = res.body.data.user.id;

      const cred = await pool.query(`select password_hash, google_sub, email_verified from user_credentials where user_id = $1`, [userId]);
      expect(cred.rows[0]).toEqual({ password_hash: null, google_sub: `sub-${email}`, email_verified: true });
      const spaces = await pool.query(`select 1 from projects where owner_user_id = $1 and visibility = 'personal'`, [userId]);
      expect(spaces.rowCount).toBe(1);
      const me = await http().get("/v1/me").set(bearer(res.body.data.token)).expect(200);
      expect(me.body.data).toMatchObject({ user_id: userId, email, display_name: "Gia New" });

      // Signing in again finds the same account by `sub` — even if Google now reports another address.
      const again = await post("/v1/auth/google", { id_token: googleToken({ sub: `sub-${email}`, email: freshEmail("moved") }) }).expect(200);
      expect(again.body.data.user.id).toBe(userId);

      // A Google-only account may set a first password without a current one.
      await http().post("/v1/auth/password").set(bearer(res.body.data.token)).send({ new_password: PASSWORD }).expect(204);
      await post("/v1/auth/login", { email, password: PASSWORD }).expect(200);
    });

    it("rejects wrong aud, expired, unverified email and a bad signature — all as one generic 401", async () => {
      const email = freshEmail("gbad");
      const impostor = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const bad = [
        googleToken({ sub: "s1", email, aud: "someone-else.apps.googleusercontent.com" }),
        googleToken({ sub: "s1", email, exp: Math.floor(Date.now() / 1000) - 30 }),
        googleToken({ sub: "s1", email, email_verified: false }),
        googleToken({ sub: "s1", email, iss: "https://accounts.evil.example" }),
        jwt.sign({ iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, sub: "s1", email, email_verified: true },
          impostor.privateKey, { algorithm: "RS256", keyid: KID, expiresIn: 600 }),
        "not-a-jwt",
      ];
      for (const idToken of bad) {
        const res = await post("/v1/auth/google", { id_token: idToken }).expect(401);
        expect(res.body.error).toMatchObject({ code: "invalid_credentials", message: "Google sign-in was not accepted" });
      }
      const rows = await pool.query(`select 1 from user_credentials where email = $1`, [email]);
      expect(rows.rowCount).toBe(0);
    });

    it("links by email — and an unverified password does not survive the link", async () => {
      const email = freshEmail("glink");
      const viaPassword = await signup(email, "Lin Ked");

      const res = await post("/v1/auth/google", { id_token: googleToken({ sub: `sub-${email}`, email }) }).expect(200);
      expect(res.body.data.user).toEqual({ id: viaPassword.user.id, email, display_name: "Lin Ked" });

      const cred = await pool.query(`select password_hash, google_sub, email_verified from user_credentials where user_id = $1`, [viaPassword.user.id]);
      expect(cred.rows[0]).toEqual({ password_hash: null, google_sub: `sub-${email}`, email_verified: true });
      // Whoever registered the address first (we never verified it) loses the
      // password and the sessions; the Google-verified owner holds the account.
      await http().get("/v1/me").set(bearer(viaPassword.token)).expect(401);
      await post("/v1/auth/login", { email, password: PASSWORD }).expect(401);
      await http().get("/v1/me").set(bearer(res.body.data.token)).expect(200);
      const accounts = await pool.query(`select 1 from user_credentials where email = $1`, [email]);
      expect(accounts.rowCount).toBe(1);
    });
  });

  describe("share by email", () => {
    async function createSpace(token: string): Promise<string> {
      const res = await http().post("/v1/projects").set(bearer(token))
        .send({ slug: `space-${randomUUID().slice(0, 8)}`, name: "Shared space", visibility: "personal" }).expect((r) => {
          if (r.status >= 300) throw new Error(`create space: ${r.status} ${JSON.stringify(r.body)}`);
        });
      return res.body.data.id as string;
    }

    it("known email → a grant, with the person attached; the space shows up in their list", async () => {
      const owner = await signup(freshEmail("owner"), "Olga Owner");
      const mateEmail = freshEmail("mate");
      const mate = await signup(mateEmail, "Matt Mate");
      const spaceId = await createSpace(owner.token);

      const put = await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token))
        .send({ email: mateEmail.toUpperCase(), role: "reader" }).expect(200);
      expect(put.body.data).toMatchObject({
        pending: false,
        resource_type: "project",
        resource_id: spaceId,
        subject_id: mate.user.id,
        role: "reader",
        subject: { id: mate.user.id, email: mateEmail, display_name: "Matt Mate" },
      });

      // Upsert: sharing again changes the role, it does not add a second row.
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: mateEmail, role: "editor" }).expect(200);
      const list = await http().get(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ role: "editor", pending: false, subject: { email: mateEmail } });

      const mateSpaces = await http().get("/v1/projects").set(bearer(mate.token)).expect(200);
      expect((mateSpaces.body.data as { id: string }[]).some((p) => p.id === spaceId)).toBe(true);

      // The user-id route still works.
      await http().put(`/v1/projects/${spaceId}/grants/${mate.user.id}`).set(bearer(owner.token)).send({ role: "reader" }).expect(200);
      // Sharing with yourself is refused; a body with neither or both targets is invalid.
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: owner.user.email, role: "reader" }).expect(400);
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ role: "reader" }).expect(400);
    });

    it("unknown email → pending → becomes a real grant when that email signs up", async () => {
      const owner = await signup(freshEmail("owner"), "Olga Owner");
      const spaceId = await createSpace(owner.token);
      const lateEmail = freshEmail("late");

      const put = await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token))
        .send({ email: lateEmail, role: "editor" }).expect(200);
      expect(put.body.data).toMatchObject({ pending: true, email: lateEmail, role: "editor" });
      expect(put.body.data.subject_id).toBeUndefined();
      // Sharing twice keeps one pending row (and takes the newer role).
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: lateEmail, role: "reader" }).expect(200);

      let list = await http().get(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ pending: true, email: lateEmail, role: "reader" })]);

      const late = await signup(lateEmail, "Lata Late");
      list = await http().get(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).expect(200);
      expect(list.body.data).toEqual([
        expect.objectContaining({
          pending: false,
          subject_id: late.user.id,
          role: "reader",
          subject: { id: late.user.id, email: lateEmail, display_name: "Lata Late" },
        }),
      ]);
      const lateSpaces = await http().get("/v1/projects").set(bearer(late.token)).expect(200);
      expect((lateSpaces.body.data as { id: string }[]).some((p) => p.id === spaceId)).toBe(true);
    });

    it("a pending share also converts on a first Google sign-in, and can be withdrawn before that", async () => {
      const owner = await signup(freshEmail("owner"));
      const spaceId = await createSpace(owner.token);
      const googleEmail = freshEmail("glate");
      const withdrawnEmail = freshEmail("withdrawn");
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: googleEmail, role: "reader" }).expect(200);
      const pending = await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: withdrawnEmail, role: "reader" }).expect(200);

      const removed = await http().delete(`/v1/projects/${spaceId}/grants/${pending.body.data.id}`).set(bearer(owner.token)).expect(200);
      expect(removed.body.data).toEqual({ revoked: true });
      const withdrawn = await signup(withdrawnEmail);

      const viaGoogle = await post("/v1/auth/google", { id_token: googleToken({ sub: `sub-${googleEmail}`, email: googleEmail }) }).expect(200);
      const list = await http().get(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ pending: false, subject_id: viaGoogle.body.data.user.id })]);
      const spaces = await http().get("/v1/projects").set(bearer(withdrawn.token)).expect(200);
      expect((spaces.body.data as { id: string }[]).some((p) => p.id === spaceId)).toBe(false);
    });

    it("session grants take an email too", async () => {
      const owner = await signup(freshEmail("owner"));
      const mateEmail = freshEmail("mate");
      const mate = await signup(mateEmail);
      const created = await http().post("/v1/sessions").set(bearer(owner.token)).send({ source: "note", title: "A private note" });
      expect(created.status).toBeLessThan(300);
      const sessionId = (created.body.data.id ?? created.body.data.session?.id) as string;

      const known = await http().put(`/v1/sessions/${sessionId}/grants`).set(bearer(owner.token)).send({ email: mateEmail, role: "reader" }).expect(200);
      expect(known.body.data).toMatchObject({ pending: false, resource_type: "session", subject: { id: mate.user.id, email: mateEmail } });
      const unknown = await http().put(`/v1/sessions/${sessionId}/grants`).set(bearer(owner.token)).send({ email: freshEmail("nobody"), role: "reader" }).expect(200);
      expect(unknown.body.data).toMatchObject({ pending: true, resource_type: "session" });
      const list = await http().get(`/v1/sessions/${sessionId}/grants`).set(bearer(owner.token)).expect(200);
      expect(list.body.data).toHaveLength(2);
    });

    it("only the owner manages the list: a grantee or a stranger gets 403/404 and never sees an email", async () => {
      const ownerEmail = freshEmail("owner");
      const owner = await signup(ownerEmail);
      const readerEmail = freshEmail("reader");
      const reader = await signup(readerEmail);
      const stranger = await signup(freshEmail("stranger"));
      const pendingEmail = freshEmail("pending");
      const spaceId = await createSpace(owner.token);
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: readerEmail, role: "reader" }).expect(200);
      await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(owner.token)).send({ email: pendingEmail, role: "reader" }).expect(200);

      for (const who of [reader, stranger]) {
        const list = await http().get(`/v1/projects/${spaceId}/grants`).set(bearer(who.token));
        expect([403, 404]).toContain(list.status);
        const put = await http().put(`/v1/projects/${spaceId}/grants`).set(bearer(who.token)).send({ email: freshEmail("x"), role: "reader" });
        expect([403, 404]).toContain(put.status);
        for (const body of [JSON.stringify(list.body), JSON.stringify(put.body)]) {
          for (const secret of [ownerEmail, readerEmail, pendingEmail]) expect(body).not.toContain(secret);
        }
      }
      await http().get(`/v1/projects/${spaceId}/grants`).expect(401);
    });
  });
});
