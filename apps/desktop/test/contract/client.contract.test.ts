// @vitest-environment node
/**
 * ONE behavioural suite, run against both adapters. It only speaks the app's
 * words (space, session, context, grant) through `OpenKTClient`, so whatever
 * passes here is what the screens can rely on regardless of the data source.
 *   mock — src/api/mock, seeded from the design canvas
 *   http — src/api/http against msw handlers that mirror the real server (test/support/fake-server.ts)
 * The same flow runs against a real server in test/live/server.live.test.ts.
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OpenKTClient } from '../../src/api/client';
import { ApiError } from '../../src/api/errors';
import { HttpClient } from '../../src/api/http';
import { MockClient } from '../../src/api/mock';
import { createFakeServer } from '../support/fake-server';

const BASE = 'http://openkt.test';
const fake = createFakeServer(BASE);
const server = setupServer(...fake.handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const adapters: [string, () => OpenKTClient][] = [
  ['mock', () => new MockClient()],
  ['http', () => new HttpClient({ baseUrl: BASE, token: fake.tokens.a })],
];

describe.each(adapters)('OpenKTClient behaviour — %s adapter', (kind, make) => {
  it('knows who is signed in', async () => {
    const me = await make().getMe();
    expect(me.id).toBeTruthy();
    expect(me.name).toMatch(/Pratham/);
    expect(me.initials).toMatch(/^[A-Z]{1,2}$/);
    expect((await make().getWorkspace()).me.id).toBe(me.id);
  });

  it('lists spaces with exactly one personal space, and can open each', async () => {
    const client = make();
    const spaces = await client.listSpaces();
    expect(spaces.filter((s) => s.personal)).toHaveLength(1);
    expect(spaces.length).toBeGreaterThan(1);
    for (const s of spaces) expect((await client.getSpace(s.id)).name).toBe(s.name);
  });

  it('new note: the session appears first in my list with its turn, context and summary', async () => {
    const client = make();
    let notified = 0;
    client.subscribe(() => (notified += 1));
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const before = (await client.getSpace(space.id)).sessionCount;

    const text = 'Quote Northgate per store. Send the revised deck on Friday.';
    const session = await client.createSession({ source: 'note', title: 'Pricing thoughts', spaceId: space.id, text });
    expect(session).toMatchObject({ source: 'note', title: 'Pricing thoughts', status: 'open', spaceId: space.id });
    expect(session.turns.map((t) => t.text)).toEqual([text]);

    const f1 = await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Quote Northgate per store', kind: 'decision' });
    await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Send the revised deck on Friday', kind: 'action' });
    expect(f1).toMatchObject({ statement: 'Quote Northgate per store', kind: 'decision', sessionId: session.id });

    const closed = await client.closeSession(session.id, 'Per-store pricing; deck on Friday.');
    expect(closed).toMatchObject({ status: 'closed', summary: 'Per-store pricing; deck on Friday.' });
    expect(notified).toBeGreaterThanOrEqual(4);

    const me = await client.getMe();
    const mine = await client.listSessions({ mine: true });
    expect(mine.find((s) => s.id === session.id)).toMatchObject({ authorId: me.id, status: 'closed', title: 'Pricing thoughts' });
    expect((await client.listSessions({ spaceId: space.id })).map((s) => s.id)).toContain(session.id);
    expect((await client.getSpace(space.id)).sessionCount).toBe(before + 1);

    expect((await client.getSession(session.id)).turns).toHaveLength(1);
    const context = await client.listContext(session.id);
    expect(context.map((c) => [c.kind, c.statement])).toEqual([
      ['decision', 'Quote Northgate per store'],
      ['action', 'Send the revised deck on Friday'],
    ]);
    expect(context.every((c) => c.author === me.name && c.spaceId === space.id)).toBe(true);
  });

  it('recall finds saved context and links to its session; a deleted fact is gone', async () => {
    const client = make();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const session = await client.createSession({ source: 'note', title: 'Warehouse', spaceId: space.id, text: 'x' });
    const fact = await client.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'The Zanzibar warehouse ships on Thursdays only', kind: 'fact' });

    const hits = await client.recall('zanzibar warehouse', { spaceId: space.id });
    expect(hits.find((h) => h.id === fact.id)).toMatchObject({ type: 'context', kind: 'fact', title: fact.statement, href: `/sessions/${session.id}/context` });

    await client.deleteFact(fact.id);
    expect((await client.recall('zanzibar warehouse', { spaceId: space.id })).some((h) => h.id === fact.id)).toBe(false);
    expect(await client.listContext(session.id)).toEqual([]);
  });

  it.each(['session', 'space'] as const)('grants on a %s: owner listed, invite → change role → remove', async (type) => {
    const client = make();
    const me = await client.getMe();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const id = type === 'space' ? space.id : (await client.createSession({ source: 'note', title: 'Shared', spaceId: space.id })).id;
    const resource = { type, id };

    const initial = await client.listGrants(resource);
    expect(initial.find((g) => g.subject.id === me.id)).toMatchObject({ role: 'owner' });

    // A teammate who already has an account, invited by email: the row carries their name and email, never an id.
    const email = kind === 'mock' ? 'ana@example.com' : 'ana@openkt.test';
    const invited = await client.inviteByEmail(resource, email, 'reader');
    expect(invited).toMatchObject({ role: 'reader', subject: { name: 'Ana Reyes', email } });
    expect(invited.pending).toBeFalsy();
    const ana = (await client.listGrants(resource)).find((g) => g.subject.email === email)?.subject;
    expect(ana).toMatchObject({ name: 'Ana Reyes', email });

    await client.putGrant(resource, ana!, 'editor');
    const after = (await client.listGrants(resource)).filter((g) => g.subject.id === ana!.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.role).toBe('editor');

    await client.deleteGrant(resource, ana!);
    expect((await client.listGrants(resource)).some((g) => g.subject.id === ana!.id)).toBe(false);
  });

  it('sharing with someone who has no account yet is a pending invitation, shown by email, that can be withdrawn', async () => {
    const client = make();
    const space = (await client.listSpaces()).find((s) => !s.personal)!;
    const resource = { type: 'space' as const, id: space.id };
    const email = `newcomer-${kind}@elsewhere.test`;

    const grant = await client.inviteByEmail(resource, email, 'editor');
    expect(grant).toMatchObject({ pending: true, role: 'editor', subject: { name: email, email } });

    const listed = (await client.listGrants(resource)).find((g) => g.subject.email === email);
    expect(listed).toMatchObject({ pending: true, role: 'editor', subject: { name: email } });

    await client.putGrant(resource, listed!.subject, 'reader');
    expect((await client.listGrants(resource)).filter((g) => g.subject.email === email).map((g) => [g.role, g.pending])).toEqual([['reader', true]]);

    await client.deleteGrant(resource, listed!.subject);
    expect((await client.listGrants(resource)).some((g) => g.subject.email === email)).toBe(false);
  });

  it('an unknown session rejects', async () => {
    await expect(make().getSession(kind === 'mock' ? 's-nope' : '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(Error);
  });

  it('says which areas are sample data', () => {
    const preview = make().preview;
    expect(preview.has('skills')).toBe(kind === 'http');
    expect(preview.has('pages')).toBe(kind === 'http');
  });
});

describe('http adapter — the edge', () => {
  it('sends the bearer token to /v1 and unwraps the envelope', async () => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('authorization')}`));
    await new HttpClient({ baseUrl: `${BASE}/`, token: fake.tokens.a }).getMe();
    server.events.removeAllListeners();
    expect(seen).toEqual([`GET /v1/me Bearer ${fake.tokens.a}`]);
  });

  it('401 → a typed unauthorized error, and the signed-out hook fires', async () => {
    let fired = 0;
    const client = new HttpClient({ baseUrl: BASE, token: 'okt_pat_wrong', onUnauthorized: () => (fired += 1) });
    const err = await client.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401, code: 'unauthorized', message: 'invalid or expired token' });
    expect(fired).toBe(1);
  });

  it('a server that is not there is a typed network error', async () => {
    const client = new HttpClient({ baseUrl: BASE, token: 'x', fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(client.getMe()).rejects.toMatchObject({ name: 'ApiError', kind: 'network' });
  });

  it('a teammate sees a granted space’s context; a stranger gets not-found; neither can manage access', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const b = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    const c = new HttpClient({ baseUrl: BASE, token: fake.tokens.c });
    const space = (await a.listSpaces()).find((s) => !s.personal)!;
    const session = await a.createSession({ source: 'note', title: 'Invoices', spaceId: space.id, text: 'x' });
    await a.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Quillfeather invoices go to accounts payable' });
    const meB = await b.getMe();
    await a.putGrant({ type: 'space', id: space.id }, { type: 'user', id: meB.id, name: meB.name, initials: meB.initials }, 'reader');

    expect((await b.recall('quillfeather invoices', { spaceId: space.id })).map((h) => h.title)).toEqual(['Quillfeather invoices go to accounts payable']);
    await expect(c.recall('quillfeather invoices', { spaceId: space.id })).rejects.toMatchObject({ kind: 'not-found' });
    await expect(c.getSession(session.id)).rejects.toMatchObject({ kind: 'not-found' });
    expect(await b.listGrants({ type: 'space', id: space.id })).toEqual([]);
  });
});
