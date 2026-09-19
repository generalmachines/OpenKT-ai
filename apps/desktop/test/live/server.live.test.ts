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
 * Skipped entirely when the URL and token are not set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors';
import { HttpClient } from '../../src/api/http';

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
