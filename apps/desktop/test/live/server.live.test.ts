// @vitest-environment node
/**
 * LIVE contract test: the http adapter against a real OpenKT server.
 *
 *   OPENKT_LIVE_URL=http://127.0.0.1:3300 OPENKT_LIVE_TOKEN=okt_pat_… npm test -- test/live
 *   (or put those lines in <repo>/.live-env, which is gitignored)
 *
 * Optional: OPENKT_LIVE_TOKEN_B (a teammate) and OPENKT_LIVE_TOKEN_C (a
 * stranger) turn on the product promise: B, granted reader, recalls A's
 * fact; C gets nothing.
 *
 * OPENKT_LIVE_SIGNUP=1 (needs only the URL) turns on the accounts flow: sign up
 * two fresh people → log in → share a space by email (known + not-yet-joined)
 * → log out, after which the token is refused. It creates real accounts
 * (`live-<stamp>-a@openkt-live.test`), so point it at a test server.
 *
 * Skipped entirely when the URL and token are not set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HttpAuth } from '../../src/api/auth';
import { ApiError } from '../../src/api/errors';
import { HttpClient } from '../../src/api/http';
import { fileCapture } from '../../src/capture/save';

function liveEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  const file = join(__dirname, '../../../../.live-env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && out[m[1]!] === undefined) out[m[1]!] = m[2];
    }
  }
  return out;
}

const env = liveEnv();
const URL_ = env['OPENKT_LIVE_URL'];
const TOKEN = env['OPENKT_LIVE_TOKEN'];
const TOKEN_B = env['OPENKT_LIVE_TOKEN_B'];
const TOKEN_C = env['OPENKT_LIVE_TOKEN_C'];
const SIGNUP = env['OPENKT_LIVE_SIGNUP'] === '1';

// Suites are skipped without env, but their bodies still run at collection time.
const client = (token: string) => new HttpClient({ baseUrl: URL_ ?? 'http://127.0.0.1:1', token });
const stamp = Date.now().toString(36);
const FACT_1 = `Live test ${stamp}: the Zanzibar warehouse ships on Thursdays only`;
const FACT_2 = `Live test ${stamp}: invoices for Quillfeather Ltd go to accounts payable, never to the buyer`;

/** Recall is served by an async index on some deployments; give it a moment. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await fn();
  }
  return last;
}

describe.skipIf(!URL_ || !TOKEN)('http adapter against a live server', () => {
  const a = client(TOKEN ?? '');
  const made: { facts: string[]; grants: (() => Promise<void>)[] } = { facts: [], grants: [] };
  let sessionId = '';
  let spaceId = '';

  afterAll(async () => {
    for (const undo of made.grants) await undo().catch(() => undefined);
    for (const id of made.facts) await a.deleteFact(id).catch(() => undefined);
  });

  it('me: the token resolves to a person', async () => {
    const me = await a.getMe();
    expect(me.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(me.name.length).toBeGreaterThan(0);
    console.log(`  me = ${me.name} <${me.email}>`);
  });

  it('a bad token is a typed unauthorized error and fires onUnauthorized', async () => {
    let fired = 0;
    const bad = new HttpClient({ baseUrl: URL_!, token: 'okt_pat_not_a_real_token', onUnauthorized: () => (fired += 1) });
    await expect(bad.getMe()).rejects.toMatchObject({ name: 'ApiError', kind: 'unauthorized', status: 401 });
    expect(fired).toBe(1);
  });

  it('spaces: includes exactly one personal space', async () => {
    const spaces = await a.listSpaces();
    expect(spaces.filter((s) => s.personal)).toHaveLength(1);
    console.log(`  spaces = ${spaces.map((s) => `${s.name}${s.personal ? '*' : ''}`).join(', ')}`);
    // Prefer a shared space so the grant half of the promise is meaningful.
    spaceId = (spaces.find((s) => !s.personal) ?? spaces[0]!).id;
    expect((await a.getSpace(spaceId)).id).toBe(spaceId);
  });

  it('new note: session → turn → 2 facts → close', async () => {
    const text = `${FACT_1}.\n${FACT_2}.`;
    const session = await a.createSession({ source: 'note', title: `Live contract test ${stamp}`, spaceId, text });
    sessionId = session.id;
    expect(session).toMatchObject({ source: 'note', status: 'open', spaceId, title: `Live contract test ${stamp}` });
    expect(session.turns.map((t) => t.text)).toEqual([text]);

    for (const statement of [FACT_1, FACT_2]) {
      const fact = await a.saveFact({ sessionId, spaceId, statement, kind: 'decision' });
      made.facts.push(fact.id);
      expect(fact).toMatchObject({ statement, kind: 'decision', sessionId, spaceId });
    }
    const closed = await a.closeSession(sessionId, 'Two shipping and invoicing rules.');
    expect(closed).toMatchObject({ id: sessionId, status: 'closed', summary: 'Two shipping and invoicing rules.' });
  });

  it('the session shows up in the list, with its turn and its context', async () => {
    const me = await a.getMe();
    const mine = await a.listSessions({ mine: true });
    expect(mine.map((s) => s.id)).toContain(sessionId);
    expect((await a.listSessions({ spaceId })).find((s) => s.id === sessionId)).toMatchObject({ authorId: me.id, status: 'closed' });

    const full = await a.getSession(sessionId);
    expect(full.turns).toHaveLength(1);
    const context = await a.listContext(sessionId);
    expect(context.map((c) => c.statement).sort()).toEqual([FACT_1, FACT_2].sort());
    expect(context.every((c) => c.kind === 'decision' && c.author === me.name)).toBe(true);
  });

  it('recall finds a fact', async () => {
    const hits = await eventually(
      () => a.recall('which day does the Zanzibar warehouse ship', { spaceId }),
      (h) => h.some((x) => x.title === FACT_1),
    );
    const hit = hits.find((x) => x.title === FACT_1);
    expect(hit).toMatchObject({ type: 'context', kind: 'decision', href: `/sessions/${sessionId}/context` });
  });

  it('grants: owner sees a list; an unknown session is a typed not-found', async () => {
    expect(Array.isArray(await a.listGrants({ type: 'session', id: sessionId }))).toBe(true);
    await expect(a.getSession('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(ApiError);
  });

  it('captures: a voice note and a screenshot file as closed sessions with their turns and facts', async () => {
    const personal = (await a.listSpaces()).find((s) => s.personal)!;
    const voice = await fileCapture(a, {
      source: 'voice',
      title: `Live voice ${stamp}`,
      spaceId: personal.id,
      turns: [`Live voice ${stamp}: give every new store a printed shelf map.`],
      summary: 'An onboarding kit idea.',
      facts: [{ kind: 'idea', statement: `Live voice ${stamp}: every new store gets a printed shelf map` }],
    });
    const shot = await fileCapture(a, {
      source: 'screenshot',
      title: `Live screenshot ${stamp}`,
      spaceId: personal.id,
      turns: ['my caption', 'Competitor pricing page, three tiers.', 'Text in image: Starter $49 · Growth $149'],
      facts: [],
    });
    expect(voice).toMatchObject({ source: 'voice', status: 'closed', spaceId: personal.id, summary: 'An onboarding kit idea.' });
    expect(shot).toMatchObject({ source: 'screenshot', status: 'closed' });
    expect((await a.getSession(shot.id)).turns.map((t) => t.text)).toEqual(['my caption', 'Competitor pricing page, three tiers.', 'Text in image: Starter $49 · Growth $149']);
    const ctx = await a.listContext(voice.id);
    made.facts.push(...ctx.map((c) => c.id));
    expect(ctx.map((c) => c.kind)).toEqual(['idea']);

    // The "models were still downloading" path files facts AFTER the session is closed.
    const late = await a.saveFact({ sessionId: shot.id, spaceId: personal.id, statement: `Live screenshot ${stamp}: the competitor's Growth tier is $149`, kind: 'fact' });
    made.facts.push(late.id);
    expect((await a.listContext(shot.id)).map((c) => c.id)).toEqual([late.id]);
  });

  describe.skipIf(!TOKEN_B || !TOKEN_C)('the product promise', () => {
    const b = client(TOKEN_B ?? '');
    const c = client(TOKEN_C ?? '');
    const asks = 'who receives invoices for Quillfeather Ltd';
    const sees = (hits: { title: string }[]) => hits.some((h) => h.title === FACT_2);

    it('before any grant, a stranger recalls nothing of A’s', async () => {
      expect(sees(await c.recall(asks).catch(() => []))).toBe(false);
      expect(sees(await c.recall(asks, { spaceId }).catch(() => []))).toBe(false);
    });

    it('B, granted reader on the space, recalls A’s fact; C still gets nothing', async () => {
      const [meB, meC] = await Promise.all([b.getMe(), c.getMe()]);
      const resource = { type: 'space' as const, id: spaceId };
      await a.putGrant(resource, { type: 'user', id: meB.id, name: meB.name, initials: meB.initials }, 'reader');
      made.grants.push(() => a.deleteGrant(resource, { type: 'user', id: meB.id }));

      const grants = await a.listGrants(resource);
      expect(grants.find((g) => g.subject.id === meB.id)).toMatchObject({ role: 'reader' });

      const forB = await eventually(() => b.recall(asks, { spaceId }), sees);
      expect(sees(forB)).toBe(true);
      expect((await b.listContext(sessionId)).map((x) => x.statement)).toContain(FACT_2);

      expect(sees(await c.recall(asks, { spaceId }).catch(() => []))).toBe(false);
      await expect(c.getSession(sessionId)).rejects.toMatchObject({ name: 'ApiError' });
      expect(meC.id).not.toBe(meB.id);
    });

    it('revoking the grant closes the door again', async () => {
      const meB = await b.getMe();
      await a.deleteGrant({ type: 'space', id: spaceId }, { type: 'user', id: meB.id });
      made.grants.length = 0;
      expect(sees(await b.recall(asks, { spaceId }).catch(() => []))).toBe(false);
    });
  });
});

describe.skipIf(!URL_ || !SIGNUP)('built-in accounts against a live server', () => {
  const auth = new HttpAuth(URL_ ?? 'http://127.0.0.1:1');
  const a = { email: `live-${stamp}-a@openkt-live.test`, password: `pw-${stamp}-correct-horse`, name: `Live A ${stamp}` };
  const b = { email: `live-${stamp}-b@openkt-live.test`, password: `pw-${stamp}-battery-staple`, name: `Live B ${stamp}` };
  let tokenA = '';

  it('providers: password is on; google says whether it is, and names a client id when it is', async () => {
    const p = await auth.providers();
    expect(p.password).toBe(true);
    if (p.google.enabled) expect(p.google.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    console.log(`  google sign-in ${p.google.enabled ? 'enabled' : 'not configured'}`);
  });

  it('signup: a new account gets an ordinary bearer token that works everywhere else', async () => {
    const session = await auth.signUp(a);
    tokenA = session.token;
    expect(session.token).toMatch(/^okt_pat_/);
    expect(session.user).toMatchObject({ email: a.email, name: a.name });
    expect(session.isNew).toBe(true);
    expect(await client(tokenA).getMe()).toMatchObject({ id: session.user.id, email: a.email, name: a.name });
    await auth.signUp(b);
  });

  it('signup again, a short password, a wrong password: each is its own typed error', async () => {
    await expect(auth.signUp(a)).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'email_taken' });
    await expect(auth.signUp({ ...a, email: `live-${stamp}-c@openkt-live.test`, password: 'short' })).rejects.toMatchObject({ code: 'weak_password' });
    await expect(auth.logIn({ email: a.email, password: 'not the password at all' })).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('login: the same person, a working token', async () => {
    const session = await auth.logIn({ email: a.email, password: a.password });
    expect(session.user.email).toBe(a.email);
    expect((await client(session.token).getMe()).email).toBe(a.email);
    tokenA = session.token;
  });

  it('share by email: a teammate with an account is granted by name; a stranger to the server is pending', async () => {
    const me = client(tokenA);
    const personal = (await me.listSpaces()).find((s) => s.personal)!;
    const session = await me.createSession({ source: 'note', title: `Live share ${stamp}`, spaceId: personal.id, text: 'shared by email' });

    for (const resource of [{ type: 'session' as const, id: session.id }, { type: 'space' as const, id: personal.id }]) {
      const known = await me.inviteByEmail(resource, b.email, 'reader');
      expect(known).toMatchObject({ role: 'reader', subject: { name: b.name, email: b.email } });
      expect(known.pending).toBeFalsy();

      const notYet = `live-${stamp}-nobody@openkt-live.test`;
      expect(await me.inviteByEmail(resource, notYet, 'editor')).toMatchObject({ pending: true, role: 'editor', subject: { email: notYet } });

      const grants = await me.listGrants(resource);
      expect(grants.find((g) => g.subject.email === b.email)).toMatchObject({ role: 'reader', subject: { name: b.name } });
      expect(grants.find((g) => g.subject.email === notYet)).toMatchObject({ pending: true });
      for (const g of grants) expect(g.subject.name).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

      await me.deleteGrant(resource, grants.find((g) => g.subject.email === b.email)!.subject);
      expect((await me.listGrants(resource)).some((g) => g.subject.email === b.email)).toBe(false);
    }
  });

  it('logout: the token stops working', async () => {
    await auth.logOut(tokenA);
    await expect(client(tokenA).getMe()).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
