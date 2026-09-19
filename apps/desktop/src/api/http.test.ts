import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http';

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('HttpClient (shape only — not run against a live server)', () => {
  it('sends the bearer token and maps a session', async () => {
    const fetch = fakeFetch({ id: 's1', source: 'meeting', title: 'Call', summary: 'x', status: 'closed', project_id: 'p1', turns: [{ speaker: 'Ana', t0_ms: 3000, content: 'hi' }] });
    const client = new HttpClient({ baseUrl: 'http://srv/', token: 'kt_abc', fetch: fetch as unknown as typeof globalThis.fetch });
    const s = await client.getSession('s1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://srv/v1/sessions/s1');
    expect(fetch.mock.calls[1]![0]).toBe('http://srv/v1/sessions/s1/turns');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer kt_abc');
    expect(s.spaceId).toBe('p1');
    expect(s.turns[0]).toMatchObject({ speaker: 'Ana', at: 3, text: 'hi' });
  });

  it('PUTs grants on the project path for spaces and the session path for sessions', async () => {
    const fetch = fakeFetch({ subject_type: 'user', subject_id: 'u1', role: 'editor' });
    const client = new HttpClient({ baseUrl: 'http://srv', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    const subject = { type: 'user' as const, id: 'u1', name: 'Ana Reyes', initials: 'AN' };
    await client.putGrant({ type: 'space', id: 'p1' }, subject, 'editor');
    await client.putGrant({ type: 'session', id: 's1' }, subject, 'editor');
    expect(fetch.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ['PUT', 'http://srv/v1/projects/p1/grants'],
      ['PUT', 'http://srv/v1/sessions/s1/grants'],
    ]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ subject_id: 'u1', role: 'editor' });
  });

  it('throws HttpError on a non-2xx', async () => {
    const client = new HttpClient({ baseUrl: 'http://srv', token: 't', fetch: fakeFetch({ message: 'nope' }, 403) as unknown as typeof globalThis.fetch });
    await expect(client.recall('x')).rejects.toMatchObject({ name: 'HttpError', status: 403 });
  });
});
