/**
 * Signing in and out. These calls happen BEFORE there is a token, so they live
 * outside `OpenKTClient`. Two implementations, like the data adapters:
 *   - HttpAuth  the server's `/v1/auth/*` endpoints (envelope `{data, error, meta}`, snake_case)
 *   - MockAuth  no server: any email with a password of 10+ characters signs in
 *
 *   GET  /v1/auth/providers → { password: true, google: { enabled, client_id?, client_secret? } }
 *   POST /v1/auth/signup {email, password, display_name, client:'desktop'} → { token, expires_at, user:{id,email,display_name} }
 *   POST /v1/auth/login  {email, password, client:'desktop'}               → same
 *   POST /v1/auth/google {id_token, client:'desktop'}                      → same
 *   POST /v1/auth/logout (bearer)                                          → 204
 *
 * The token is an ordinary `okt_pat_…` bearer: it is stored where a pasted
 * token always was (the OS keychain, see src/api/index.ts).
 */
import type { NetRequest, NetResponse } from '../shared/ipc';
import { netRequest } from './bridge';
import { MIN_PASSWORD_LENGTH } from './config';
import { ApiError, kindForStatus } from './errors';

export interface AuthProviders {
  password: boolean;
  google: { enabled: boolean; clientId: string; clientSecret?: string };
}

export interface AuthSession {
  token: string;
  expiresAt: string;
  user: { id: string; email: string; name: string };
  /** The server may say the account was created by this very call (Google, first time). */
  isNew: boolean;
}

export interface AuthApi {
  providers(): Promise<AuthProviders>;
  signUp(input: { email: string; password: string; name: string }): Promise<AuthSession>;
  logIn(input: { email: string; password: string }): Promise<AuthSession>;
  /** `idToken` comes from the system-browser flow in main (src/main/auth/google.ts). */
  google(idToken: string): Promise<AuthSession>;
  /** Best effort: the local token is forgotten whether or not the server hears about it. */
  logOut(token: string): Promise<void>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toSession(data: unknown, fallbackEmail = ''): AuthSession {
  const j = obj(data);
  const user = obj(j['user']);
  const token = str(j['token']);
  if (!token) throw new ApiError('server', 'The server did not return a session.', 200, 'no_token', '/auth');
  const email = str(user['email']) || fallbackEmail;
  return {
    token,
    expiresAt: str(j['expires_at']),
    user: { id: str(user['id']) || str(user['user_id']), email, name: str(user['display_name']) || email },
    isNew: j['is_new'] === true || j['is_new_user'] === true || j['created'] === true || user['is_new'] === true,
  };
}

export class HttpAuth implements AuthApi {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch | null = null,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  /** Same order as HttpClient: an injected fetch (tests), main's proxy (packaged app, no CORS), window.fetch. */
  private async send(req: NetRequest): Promise<NetResponse> {
    const viaMain = this.fetchImpl ? null : netRequest();
    if (viaMain) return viaMain(req);
    const res = await (this.fetchImpl ?? globalThis.fetch.bind(globalThis))(req.url, { method: req.method, headers: req.headers, body: req.body });
    return { status: res.status, body: await res.text() };
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<unknown> {
    let res: NetResponse;
    try {
      res = await this.send({
        url: `${this.baseUrl}/v1${path}`,
        method,
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError('network', e instanceof Error ? e.message : String(e), 0, '', path);
    }
    let parsed: Json = {};
    try {
      parsed = res.body ? obj(JSON.parse(res.body)) : {};
    } catch {
      // A 2xx that is not JSON is some other web server answering at this address.
      if (res.status >= 200 && res.status < 300 && res.status !== 204) throw new ApiError('not-found', 'Not an OpenKT server.', res.status, 'not_json', path);
    }
    if (res.status < 200 || res.status >= 300) {
      const err = obj(parsed['error']);
      throw new ApiError(kindForStatus(res.status), str(err['message']) || `The server answered ${res.status}.`, res.status, str(err['code']), path);
    }
    return parsed['data'];
  }

  async providers(): Promise<AuthProviders> {
    const j = obj(await this.call('GET', '/auth/providers'));
    const g = obj(j['google']);
    const clientId = str(g['client_id']);
    return { password: j['password'] !== false, google: { enabled: g['enabled'] === true && Boolean(clientId), clientId, clientSecret: str(g['client_secret']) || undefined } };
  }

  async signUp(input: { email: string; password: string; name: string }): Promise<AuthSession> {
    return { ...toSession(await this.call('POST', '/auth/signup', { email: input.email, password: input.password, display_name: input.name, client: 'desktop' }), input.email), isNew: true };
  }

  async logIn(input: { email: string; password: string }): Promise<AuthSession> {
    return toSession(await this.call('POST', '/auth/login', { email: input.email, password: input.password, client: 'desktop' }), input.email);
  }

  async google(idToken: string): Promise<AuthSession> {
    return toSession(await this.call('POST', '/auth/google', { id_token: idToken, client: 'desktop' }));
  }

  async logOut(token: string): Promise<void> {
    if (token) await this.call('POST', '/auth/logout', undefined, token).catch(() => undefined);
  }
}

/** The person the sample data is written around; "Continue with Google" signs in as them. */
export const SAMPLE_USER = { id: 'u-pratham', email: 'pratham@example.com', name: 'Pratham Bhatnagar' } as const;
export const MOCK_TOKEN = 'mock-session';

export class MockAuth implements AuthApi {
  private static taken = new Set<string>(['taken@example.com']);

  private session(email: string, name: string, isNew: boolean): AuthSession {
    return { token: MOCK_TOKEN, expiresAt: '', user: { id: SAMPLE_USER.id, email, name: name || email }, isNew };
  }

  async providers(): Promise<AuthProviders> {
    return { password: true, google: { enabled: true, clientId: 'sample' } };
  }

  async signUp(input: { email: string; password: string; name: string }): Promise<AuthSession> {
    if (MockAuth.taken.has(input.email.toLowerCase())) throw new ApiError('conflict', 'email taken', 409, 'email_taken', '/auth/signup');
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new ApiError('invalid', 'weak password', 422, 'weak_password', '/auth/signup');
    return this.session(input.email, input.name, true);
  }

  async logIn(input: { email: string; password: string }): Promise<AuthSession> {
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new ApiError('unauthorized', 'invalid credentials', 401, 'invalid_credentials', '/auth/login');
    return this.session(input.email, input.email.toLowerCase() === SAMPLE_USER.email ? SAMPLE_USER.name : '', false);
  }

  async google(): Promise<AuthSession> {
    return this.session(SAMPLE_USER.email, SAMPLE_USER.name, false);
  }

  async logOut(): Promise<void> {
    /* nothing to tell */
  }
}

export type AuthMode = 'signin' | 'signup' | 'token' | 'google';

/** One human sentence per failure. No status codes, no server strings, no jargon. */
export function describeAuthError(e: unknown, mode: AuthMode, customServer = false): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (e.kind === 'network') return customServer ? 'Can’t reach that server. Check the address and your connection.' : 'Can’t reach OpenKT right now. Check your connection.';
  switch (e.code) {
    case 'invalid_credentials':
      return 'That email and password don’t match.';
    case 'email_taken':
      return 'There’s already an account with that email — sign in instead.';
    case 'weak_password':
      // The form already checks the length, so when the server still says no it is about what the password IS.
      if (/common/i.test(e.message)) return 'That password is too easy to guess. Choose another.';
      if (/email/i.test(e.message)) return 'Your password can’t be your email address. Choose another.';
      return `Choose a longer password — at least ${MIN_PASSWORD_LENGTH} characters.`;
    case 'rate_limited':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'provider_disabled':
      return 'Google sign-in isn’t available here. Use your email and password.';
  }
  if (e.kind === 'rate-limited') return 'Too many tries. Wait a few minutes and try again.';
  if (mode === 'token' && (e.kind === 'unauthorized' || e.kind === 'forbidden')) return 'That access token didn’t work. Check it and try again.';
  if (e.kind === 'unauthorized') return mode === 'google' ? 'Google sign-in didn’t work for that account. Try again.' : 'That email and password don’t match.';
  if (e.kind === 'conflict') return 'There’s already an account with that email — sign in instead.';
  if (e.kind === 'not-found') return customServer ? 'That address doesn’t look like OpenKT. Check it and try again.' : 'Can’t reach OpenKT right now. Try again in a moment.';
  if (e.kind === 'invalid') return mode === 'signup' ? 'Check your name, email and password, then try again.' : 'Check your email and password, then try again.';
  return 'Something went wrong on our side. Please try again.';
}
