import { ConnectError } from './errors.js';

/** The few server calls connect needs (the full client is packages/sdk, Spec 06 §5). Responses use {data,error,meta}. */
export interface ServerResponse<T = unknown> {
  status: number;
  data: T | null;
  error: { code?: string; message?: string } | null;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' | 'follow' }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export async function call<T = unknown>(
  fetchImpl: FetchLike,
  server: string,
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<ServerResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'openkt-connect' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  let res;
  try {
    res = await fetchImpl(`${server}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}), signal });
  } catch (err) {
    return { status: 0, data: null, error: { code: 'network', message: err instanceof Error ? err.message : String(err) } };
  }
  const text = await res.text().catch(() => '');
  let parsed: { data?: T; error?: { code?: string; message?: string } | null } = {};
  try {
    parsed = text ? (JSON.parse(text) as typeof parsed) : {};
  } catch {
    // Not JSON (a proxy error page): keep the status.
  }
  return { status: res.status, data: parsed.data ?? null, error: parsed.error ?? (res.status >= 400 ? { code: `http_${res.status}` } : null) };
}

/** Map a failed response to a ConnectError with Spec 06 exit semantics. */
export function toError(res: ServerResponse, what: string): ConnectError {
  if (res.status === 0) return new ConnectError('network', `${what}: cannot reach the server (${res.error?.message ?? 'no response'})`);
  if (res.status === 401 || res.status === 403) return new ConnectError('unauthorized', `${what}: not signed in or the sign-in expired`, { hint: 'run: openkt-connect auth login --email you@example.com --password-stdin' });
  if (res.status >= 500) return new ConnectError('server', `${what}: the server answered ${res.status}`);
  return new ConnectError('invalid', `${what}: ${res.error?.message ?? `the server answered ${res.status}`}`);
}

/**
 * claude.ai and ChatGPT connect through the server's OAuth sign-in. Its consent page is the web app named by
 * OPENKT_DASHBOARD_URL; when that points at localhost the browser flow cannot finish, and the guided card says so.
 */
export async function oauthConsentReachable(fetchImpl: FetchLike, mcpOrigin: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const reg = await fetchImpl(`${mcpOrigin}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'openkt-connect check', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'none' }),
      signal: AbortSignal.timeout(8000),
    });
    const client = JSON.parse(await reg.text()) as { client_id?: string };
    if (!client.client_id) return { ok: false, detail: `client registration answered ${reg.status}` };
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 'check' });
    const res = await fetchImpl(`${mcpOrigin}/oauth/authorize?${q}`, { method: 'GET', headers: {}, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400 && location) {
      const host = new URL(location, mcpOrigin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return { ok: false, detail: `the sign-in page redirects to ${new URL(location).origin}, which only exists on the server's own machine` };
      return { ok: true, detail: `sign-in page at ${new URL(location, mcpOrigin).origin}` };
    }
    return { ok: res.status === 200, detail: `authorize answered ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
