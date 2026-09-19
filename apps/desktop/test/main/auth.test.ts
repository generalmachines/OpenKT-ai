// @vitest-environment node
/**
 * Google sign-in, without Google: the PKCE helpers against the RFC 7636 vector, the
 * loopback listener with plain Node http, and the whole flow with a fake browser and
 * a fake token endpoint.
 */
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizationUrl, signInWithGoogle } from '../../src/main/auth/google';
import { startLoopback, type Loopback } from '../../src/main/auth/loopback';
import { challengeFor, createState, createVerifier } from '../../src/main/auth/pkce';

/** GET without following anything; resolves with status and body, or the connection error code. */
function hit(url: string): Promise<{ status: number; body: string } | { refused: string }> {
  return new Promise((resolve) => {
    const req = get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ refused: e.code ?? 'error' }));
    req.setTimeout(1500, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
}

const open: Loopback[] = [];
const loopback = async (opts: Parameters<typeof startLoopback>[0]) => {
  const l = await startLoopback(opts);
  open.push(l);
  return l;
};
afterEach(() => {
  for (const l of open.splice(0)) l.close();
});

describe('PKCE helpers', () => {
  it('matches the RFC 7636 appendix B vector (S256)', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes verifiers of 43–128 unreserved characters, different every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const v = createVerifier();
      expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
      expect(challengeFor(v)).toMatch(/^[A-Za-z0-9\-_]{43}$/);
      seen.add(v);
    }
    expect(seen.size).toBe(50);
    expect(createState()).not.toBe(createState());
    expect(createState().length).toBeGreaterThanOrEqual(32);
  });

  it('builds the authorization URL Google expects', () => {
    const u = new URL(authorizationUrl({ clientId: 'abc.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5123', challenge: 'CH', state: 'ST' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'abc.apps.googleusercontent.com',
      redirect_uri: 'http://127.0.0.1:5123',
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      state: 'ST',
    });
  });
});

describe('loopback listener', () => {
  it('hands over the code when the state matches, and shows the plain “signed in” page', async () => {
    const l = await loopback({ state: 'good', timeoutMs: 5000 });
    expect(l.redirectUri).toBe(`http://127.0.0.1:${l.port}`);
    const res = await hit(`${l.redirectUri}/?code=4%2Fabc&state=good`);
    expect(res).toMatchObject({ status: 200 });
    expect('body' in res && res.body).toContain('You’re signed in — you can close this tab and return to OpenKT.');
    await expect(l.code).resolves.toBe('4/abc');
  });

  it('rejects a callback whose state does not match', async () => {
    const l = await loopback({ state: 'good', timeoutMs: 5000 });
    const res = await hit(`${l.redirectUri}/?code=stolen&state=evil`);
    expect(res).toMatchObject({ status: 400 });
    expect('body' in res && res.body).not.toContain('signed in');
    await expect(l.code).rejects.toMatchObject({ name: 'AuthFlowError', kind: 'failed' });
  });

  it('ignores the browser’s favicon request and still takes the real callback', async () => {
    const l = await loopback({ state: 's', timeoutMs: 5000 });
    expect(await hit(`${l.redirectUri}/favicon.ico`)).toMatchObject({ status: 404 });
    await hit(`${l.redirectUri}/?code=c1&state=s`);
    await expect(l.code).resolves.toBe('c1');
  });

  it('reads “access_denied” as the person cancelling', async () => {
    const l = await loopback({ state: 's', timeoutMs: 5000 });
    await hit(`${l.redirectUri}/?error=access_denied&state=s`);
    await expect(l.code).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('times out, and the port is closed afterwards', async () => {
    const l = await loopback({ state: 's', timeoutMs: 60 });
    await expect(l.code).rejects.toMatchObject({ kind: 'timeout' });
    await new Promise((r) => setTimeout(r, 30));
    expect(await hit(`${l.redirectUri}/?code=late&state=s`)).toMatchObject({ refused: 'ECONNREFUSED' });
  });

  it('can be cancelled from the app', async () => {
    const controller = new AbortController();
    const l = await loopback({ state: 's', timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    await expect(l.code).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('listens on 127.0.0.1 only — not reachable on any other interface of this machine', async () => {
    const l = await loopback({ state: 's', timeoutMs: 5000 });
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a): a is NonNullable<typeof a> => Boolean(a) && a!.family === 'IPv4' && !a!.internal)
      .map((a) => a.address);
    for (const address of others) expect(await hit(`http://${address}:${l.port}/?code=x&state=s`)).toHaveProperty('refused');
    expect(await hit(`http://[::1]:${l.port}/?code=x&state=s`)).toHaveProperty('refused');
    // …and still alive for the real callback: none of the above reached it.
    await hit(`${l.redirectUri}/?code=mine&state=s`);
    await expect(l.code).resolves.toBe('mine');
  });
});

describe('signInWithGoogle', () => {
  let tokenServer: Server | null = null;
  afterEach(() => tokenServer?.close());

  /** A stand-in for oauth2.googleapis.com/token that records the form it was sent. */
  async function fakeTokenEndpoint(answer: (form: URLSearchParams) => { status: number; body: unknown }) {
    const forms: URLSearchParams[] = [];
    tokenServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        forms.push(form);
        const a = answer(form);
        res.writeHead(a.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>((r) => tokenServer!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`, forms };
  }

  /** Plays the browser: follows the authorization URL straight back to the redirect_uri. */
  const browser = (mutate: (p: URLSearchParams) => void = () => undefined) => {
    const opened: URL[] = [];
    return {
      opened,
      openExternal: async (url: string) => {
        const u = new URL(url);
        opened.push(u);
        const back = new URLSearchParams({ code: 'auth-code-1', state: u.searchParams.get('state') ?? '' });
        mutate(back);
        setTimeout(() => void hit(`${u.searchParams.get('redirect_uri')}/?${back}`), 5);
      },
    };
  };

  it('opens the system browser, verifies the state, exchanges the code with the verifier, returns the id_token', async () => {
    const endpoint = await fakeTokenEndpoint(() => ({ status: 200, body: { id_token: 'header.payload.sig', access_token: 'ya29.x' } }));
    const b = browser();
    const out = await signInWithGoogle({ clientId: 'cid.apps.googleusercontent.com' }, { openExternal: b.openExternal, fetch, tokenEndpoint: endpoint.url, timeoutMs: 5000 });
    expect(out).toEqual({ id_token: 'header.payload.sig' });

    const asked = b.opened[0]!.searchParams;
    expect(asked.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const form = endpoint.forms[0]!;
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code-1', client_id: 'cid.apps.googleusercontent.com', redirect_uri: asked.get('redirect_uri') });
    expect(challengeFor(form.get('code_verifier')!)).toBe(asked.get('code_challenge'));
    expect(form.has('client_secret')).toBe(false);
  });

  it('sends the client secret only when the server published one', async () => {
    const endpoint = await fakeTokenEndpoint((form) => (form.get('client_secret') === 'GOCSPX-desktop' ? { status: 200, body: { id_token: 't' } } : { status: 400, body: { error: 'invalid_request', error_description: 'client_secret is missing.' } }));
    const deps = () => ({ openExternal: browser().openExternal, fetch, tokenEndpoint: endpoint.url, timeoutMs: 5000 });
    await expect(signInWithGoogle({ clientId: 'cid' }, deps())).rejects.toMatchObject({ kind: 'failed', message: 'client_secret is missing.' });
    await expect(signInWithGoogle({ clientId: 'cid', clientSecret: 'GOCSPX-desktop' }, deps())).resolves.toEqual({ id_token: 't' });
  });

  it('never reaches the token endpoint when the state was tampered with', async () => {
    const endpoint = await fakeTokenEndpoint(() => ({ status: 200, body: { id_token: 't' } }));
    const b = browser((p) => p.set('state', 'tampered'));
    await expect(signInWithGoogle({ clientId: 'cid' }, { openExternal: b.openExternal, fetch, tokenEndpoint: endpoint.url, timeoutMs: 5000 })).rejects.toMatchObject({ kind: 'failed' });
    expect(endpoint.forms).toHaveLength(0);
  });

  it('times out when nobody comes back, and cancels on request', async () => {
    const idle = { openExternal: async () => undefined, fetch };
    await expect(signInWithGoogle({ clientId: 'cid' }, { ...idle, timeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' });
    const controller = new AbortController();
    const pending = signInWithGoogle({ clientId: 'cid' }, { ...idle, timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
