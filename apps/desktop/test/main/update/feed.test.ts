import { describe, expect, it } from 'vitest';
import { DEFAULT_FEED_URL, FeedError, decide, fetchFeed, parseFeed, resolveFeedConfig, type FeedConfig } from '../../../src/main/update/feed';

const HOST = 'https://openkt-downloads-724772068721.s3.ap-south-1.amazonaws.com/desktop';
const PROD: FeedConfig = { url: `${HOST}/latest.json`, allowLoopbackHttp: false };
const SHA = 'a'.repeat(64);

function feed(over: Record<string, unknown> = {}, zip: Record<string, unknown> = {}) {
  return {
    version: '0.3.128',
    channel: 'stable',
    released_at: '2026-09-19T10:00:00Z',
    commit: '63a4d5f0000000000000000000000000000000000',
    notes: ['Sign in with email and password', 'Skills screen'],
    min_os: '13.3',
    files: {
      zip: { url: `${HOST}/releases/0.3.128/OpenKT-0.3.128-arm64.zip`, sha256: SHA, size: 1000, ...zip },
      dmg: { url: `${HOST}/releases/0.3.128/OpenKT-0.3.128-arm64.dmg`, sha256: SHA, size: 2000 },
    },
    ...over,
  };
}

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as FeedError).code;
  }
  return 'ok';
};

describe('feed config', () => {
  it('uses the pinned S3 feed; the env override needs OPENKT_SMOKE=1', () => {
    expect(resolveFeedConfig({})).toEqual({ url: DEFAULT_FEED_URL, allowLoopbackHttp: false });
    expect(resolveFeedConfig({ OPENKT_UPDATE_FEED: 'https://evil.example/latest.json' }).url).toBe(DEFAULT_FEED_URL);
    expect(resolveFeedConfig({ OPENKT_UPDATE_FEED: 'http://127.0.0.1:9/latest.json', OPENKT_SMOKE: '1' })).toEqual({ url: 'http://127.0.0.1:9/latest.json', allowLoopbackHttp: true });
    expect(new URL(DEFAULT_FEED_URL).host).toBe(new URL(HOST).host);
  });
});

describe('parseFeed', () => {
  it('accepts a complete feed and normalises it', () => {
    const f = parseFeed(feed(), PROD);
    expect(f.version).toBe('0.3.128');
    expect(f.files.zip.size).toBe(1000);
    expect(f.notes).toHaveLength(2);
    expect(f.commit).toHaveLength(40);
  });

  it('refuses files on another host', () => {
    expect(code(() => parseFeed(feed({}, { url: 'https://evil.example/OpenKT.zip' }), PROD))).toBe('wrong_host');
    expect(code(() => parseFeed(feed({}, { url: 'https://openkt-downloads-724772068721.s3.ap-south-1.amazonaws.com.evil.example/x.zip' }), PROD))).toBe('wrong_host');
    expect(code(() => parseFeed(feed({}, { url: `https://user:pw@${new URL(HOST).host}/desktop/x.zip` }), PROD))).toBe('bad_url');
  });

  it('refuses http, even for the feed itself, unless it is the smoke loopback', () => {
    expect(code(() => parseFeed(feed({}, { url: `${HOST.replace('https:', 'http:')}/x.zip` }), PROD))).toBe('insecure');
    expect(code(() => parseFeed(feed(), { url: `${HOST.replace('https:', 'http:')}/latest.json`, allowLoopbackHttp: false }))).toBe('insecure');
    expect(code(() => parseFeed(feed(), { url: 'http://localhost:8/latest.json', allowLoopbackHttp: true }))).toBe('insecure');
    const loop: FeedConfig = { url: 'http://127.0.0.1:8765/latest.json', allowLoopbackHttp: true };
    const zipOnly = (url: string) => feed({ files: { zip: { url, sha256: SHA, size: 1000 } } });
    expect(parseFeed(zipOnly('http://127.0.0.1:8765/OpenKT.zip'), loop).files.zip.url).toBe('http://127.0.0.1:8765/OpenKT.zip');
    expect(code(() => parseFeed(zipOnly('http://127.0.0.1:9999/OpenKT.zip'), loop))).toBe('wrong_host');
    // Every listed file must be on the feed host, the disk image included.
    expect(code(() => parseFeed(feed({}, { url: 'http://127.0.0.1:8765/OpenKT.zip' }), loop))).toBe('wrong_host');
  });

  it('refuses malformed feeds', () => {
    for (const bad of [null, [], 'x', feed({ version: 'latest' }), feed({ version: undefined }), feed({ files: undefined })]) {
      expect(code(() => parseFeed(bad, PROD))).toBe('malformed');
    }
    expect(code(() => parseFeed(feed({}, { sha256: 'abc' }), PROD))).toBe('malformed');
    expect(code(() => parseFeed(feed({}, { size: -1 }), PROD))).toBe('malformed');
    expect(code(() => parseFeed(feed({}, { size: '1000' }), PROD))).toBe('malformed');
    expect(code(() => parseFeed(feed({}, { size: 5 * 1024 ** 3 }), PROD))).toBe('malformed');
    expect(code(() => parseFeed(feed({}, { url: 'not a url' }), PROD))).toBe('bad_url');
  });

  it('keeps notes short and plain', () => {
    const f = parseFeed(feed({ notes: [...Array(15).keys()].map((i) => `  note ${i}  `).concat(['', 42 as unknown as string]) }), PROD);
    expect(f.notes).toHaveLength(10);
    expect(f.notes[0]).toBe('note 0');
    expect(parseFeed(feed({ notes: 'one\ntwo' }), PROD).notes).toEqual(['one', 'two']);
  });
});

describe('decide', () => {
  const f = parseFeed(feed(), PROD);
  it('offers only a strictly newer version on the same channel', () => {
    expect(decide(f, { version: '0.3.127', channel: 'stable' }).kind).toBe('update');
    expect(decide(f, { version: '0.3.0-dev.0', channel: 'stable' }).kind).toBe('update');
    expect(decide(f, { version: '0.3.128', channel: 'stable' }).kind).toBe('current');
  });
  it('never downgrades', () => {
    expect(decide(f, { version: '0.3.129', channel: 'stable' }).kind).toBe('not-newer');
    expect(decide(f, { version: '1.0.0', channel: 'stable' }).kind).toBe('not-newer');
  });
  it('respects channel, a rolled-back version and the minimum macOS', () => {
    expect(decide(f, { version: '0.3.1', channel: 'beta' }).kind).toBe('other-channel');
    expect(decide(f, { version: '0.3.1', channel: 'stable', blocked: ['0.3.128'] }).kind).toBe('blocked');
    expect(decide(f, { version: '0.3.1', channel: 'stable', osVersion: '13.2.1' }).kind).toBe('needs-newer-os');
    expect(decide(f, { version: '0.3.1', channel: 'stable', osVersion: '14.6.1' }).kind).toBe('update');
  });
});

describe('fetchFeed', () => {
  const ok = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it('parses what the server returns and refuses redirects', async () => {
    let init: RequestInit | undefined;
    const f = await fetchFeed(PROD, { fetch: (async (_u: string, i: RequestInit) => ((init = i), new Response(JSON.stringify(feed())))) as unknown as typeof fetch });
    expect(f.version).toBe('0.3.128');
    expect(init?.redirect).toBe('error');
  });
  it('maps a missing feed to not_published and other failures to fetch_failed', async () => {
    await expect(fetchFeed(PROD, { fetch: ok('<Error/>', 403) })).rejects.toMatchObject({ code: 'not_published' });
    await expect(fetchFeed(PROD, { fetch: ok('', 404) })).rejects.toMatchObject({ code: 'not_published' });
    await expect(fetchFeed(PROD, { fetch: ok('', 500) })).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(fetchFeed(PROD, { fetch: ok('{nope') })).rejects.toMatchObject({ code: 'malformed' });
    await expect(fetchFeed(PROD, { fetch: ok('x'.repeat(70_000)) })).rejects.toMatchObject({ code: 'malformed' });
  });
  it('gives up after the timeout', async () => {
    const hang = ((_u: string, i: RequestInit) => new Promise((_r, reject) => i.signal?.addEventListener('abort', () => reject(i.signal?.reason)))) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(fetchFeed(PROD, { fetch: hang, timeoutMs: 100 })).rejects.toMatchObject({ code: 'fetch_failed' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('refuses an http feed URL before any request', async () => {
    let called = false;
    const spy = (async () => ((called = true), new Response('{}'))) as unknown as typeof fetch;
    await expect(fetchFeed({ url: 'http://example.com/latest.json', allowLoopbackHttp: false }, { fetch: spy })).rejects.toMatchObject({ code: 'insecure' });
    expect(called).toBe(false);
  });
});
