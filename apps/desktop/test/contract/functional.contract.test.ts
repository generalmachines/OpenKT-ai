// @vitest-environment node
/**
 * What the owner has to be able to do on day one, through `OpenKTClient`, on both adapters:
 * write a note, find it with ⌘K (by its words and by its title), make a space and share it,
 * and have the teammate find what was shared. The same steps run against api.openkt.ai in
 * e2e/journey.mjs; this is the fast, offline half.
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OpenKTClient } from '../../src/api/client';
import { HttpClient } from '../../src/api/http';
import { MockClient } from '../../src/api/mock';
import { asWritten } from '../../src/capture/save';
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

describe.each(adapters)('day one — %s adapter', (_kind, make) => {
  it('a note saved without local AI is found by its words', async () => {
    const client = make();
    const personal = (await client.listSpaces()).find((s) => s.personal)!;
    const text = 'We quote the Walrus Grocers account per store, not per seat.';
    const session = await client.createSession({ source: 'note', title: 'Walrus pricing', spaceId: personal.id, text, extractedOn: 'none' });
    await client.saveFact(asWritten(session.id, personal.id, 'Walrus pricing', text));
    await client.closeSession(session.id, text);

    expect((await client.getSession(session.id)).extractedOn).toBe('none');
    const context = await client.listContext(session.id);
    expect(context).toHaveLength(1);
    expect(context[0]!.statement).toContain('per store, not per seat');
    const hits = await client.recall('Walrus Grocers account');
    expect(hits.some((h) => h.type === 'context' && h.href.startsWith(`/sessions/${session.id}`))).toBe(true);
  });

  it('⌘K finds a session by its title', async () => {
    const client = make();
    const personal = (await client.listSpaces()).find((s) => s.personal)!;
    const session = await client.createSession({ source: 'note', title: 'Otter onboarding checklist', spaceId: personal.id, text: 'x' });
    const hits = await client.recall('otter onboarding');
    expect(hits.find((h) => h.type === 'session')).toMatchObject({ id: session.id, href: `/sessions/${session.id}` });
  });

  it('a new space is listed and can be shared by email', async () => {
    const client = make();
    const space = await client.createSpace({ name: 'Customer: Otter Logistics' });
    expect(space.name).toBe('Customer: Otter Logistics');
    expect(space.personal).toBeFalsy();
    expect((await client.listSpaces()).map((s) => s.id)).toContain(space.id);
    const email = _kind === 'mock' ? 'ravi@example.com' : 'ana@openkt.test';
    await client.inviteByEmail({ type: 'space', id: space.id }, email, 'reader');
    expect((await client.listGrants({ type: 'space', id: space.id })).some((g) => g.subject.email === email)).toBe(true);
  });
});

describe('http adapter — a teammate recalls what was shared with them', () => {
  it('context in a space shared with them is found with no space named (⌘K "everything you can read")', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const b = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    const space = await a.createSpace({ name: 'Team Heron' });
    const session = await a.createSession({ source: 'note', title: 'Heron renewal', spaceId: space.id, text: 'Heron renews in March; they want SSO first.' });
    await a.saveFact({ sessionId: session.id, spaceId: space.id, statement: 'Heron renews in March and wants SSO before signing' });

    expect(await b.recall('heron renews march')).toEqual([]);
    await a.inviteByEmail({ type: 'space', id: space.id }, 'ana@openkt.test', 'reader');

    const hits = await b.recall('heron renews march');
    expect(hits.map((h) => h.title)).toContain('Heron renews in March and wants SSO before signing');
    // …and the shared space's sessions are findable by title too.
    const fresh = new HttpClient({ baseUrl: BASE, token: fake.tokens.b });
    expect((await fresh.recall('heron renewal')).some((h) => h.type === 'session' && h.id === session.id)).toBe(true);
    // The teammate's own spaces still come first in scope: nothing of the stranger's leaks.
    const c = new HttpClient({ baseUrl: BASE, token: fake.tokens.c });
    expect(await c.recall('heron renews march')).toEqual([]);
  });
});

describe('http adapter — a network blip is not an outage', () => {
  const flaky = (failures: number, error = 'net::ERR_NETWORK_CHANGED') => {
    const seen: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (seen.length <= failures) throw new Error(error);
      return new Response(JSON.stringify({ data: { user_id: 'u1', email: 'a@b.test', display_name: 'A' }, error: null, meta: null }), { status: 200 });
    }) as typeof fetch;
    return { seen, impl };
  };

  it('a read that fails with ERR_NETWORK_CHANGED is sent again and succeeds', async () => {
    const { seen, impl } = flaky(2);
    expect((await new HttpClient({ baseUrl: BASE, token: 't', fetch: impl }).getMe()).email).toBe('a@b.test');
    expect(seen).toEqual(['GET /v1/me', 'GET /v1/me', 'GET /v1/me']);
  });

  it('a write is never sent twice, and a server that is not there fails at once', async () => {
    // Reads answer; the first write drops on the floor the way a network change drops it.
    const seen: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      seen.push(`${method} ${new URL(url).pathname}`);
      if (method === 'POST') throw new Error('net::ERR_NETWORK_CHANGED');
      return new Response(JSON.stringify({ data: { user_id: 'u1', email: 'a@b.test', display_name: 'A' }, error: null, meta: null }), { status: 200 });
    }) as typeof fetch;
    await expect(new HttpClient({ baseUrl: BASE, token: 't', fetch: impl }).createSpace({ name: 'X' })).rejects.toMatchObject({ kind: 'network' });
    expect(seen.filter((r) => r.startsWith('POST'))).toEqual(['POST /v1/projects']);
    const down = flaky(9, 'net::ERR_CONNECTION_REFUSED');
    await expect(new HttpClient({ baseUrl: BASE, token: 't', fetch: down.impl }).getMe()).rejects.toMatchObject({ kind: 'network' });
    expect(down.seen).toHaveLength(1);
  });
});

describe('http adapter — the personal space is the personal space', () => {
  it('when the server’s default points at another private space, notes still go to Personal', async () => {
    const a = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const team = await a.createSpace({ name: 'Team Kestrel' });
    await a.inviteByEmail({ type: 'space', id: team.id }, 'ana@openkt.test', 'reader');
    fake.state.personalAmbiguous = true;
    try {
      const fresh = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
      const personal = (await fresh.listSpaces()).find((s) => s.personal)!;
      expect(personal.id).not.toBe(team.id);
      expect(personal.name).toBe('Personal');
      // A capture that names no space lands in Personal, not in the space shared with a teammate.
      const session = await fresh.createSession({ source: 'voice', title: 'Private thought', spaceId: '', text: 'salary ask: 185k' });
      expect(session.spaceId).toBe(personal.id);
    } finally {
      fake.state.personalAmbiguous = false;
    }
  });
});
