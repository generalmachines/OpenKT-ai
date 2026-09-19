/**
 * Google sign-in for a desktop app: loopback redirect + PKCE, in the SYSTEM
 * browser (never an embedded web view — Google blocks those, and the person's
 * saved Google session lives in their browser).
 *
 *   1. listen on http://127.0.0.1:<random port>            (./loopback.ts)
 *   2. open accounts.google.com with client_id, redirect_uri, response_type=code,
 *      scope "openid email profile", code_challenge (S256) and a random state
 *   3. Google redirects back with ?code&state; the state is verified
 *   4. exchange the code at oauth2.googleapis.com/token with the code_verifier
 *   5. hand the `id_token` to the renderer, which posts it to `POST /v1/auth/google`
 *
 * The client id comes from the server (`GET /v1/auth/providers` → google.client_id),
 * so one build works against any server. It must be a Google Cloud OAuth client of
 * type "Desktop app": those accept any 127.0.0.1 port without registering it.
 *
 * About `client_secret`: PKCE alone is meant to be enough for a Desktop client, but
 * Google's token endpoint still answers `client_secret is missing` for many of them.
 * Google documents that a Desktop client's secret "is obviously not treated as a
 * secret", so the server MAY publish it as `google.client_secret` in the providers
 * response; when present it is sent with the exchange, and when Google asks for one
 * that was not provided the flow fails with a message that says so. Never put the
 * secret of a "Web application" client there.
 *
 * Nothing here logs: codes, verifiers and tokens never reach a console or a file.
 */
import { AuthFlowError, startLoopback } from './loopback';
import { challengeFor, createState, createVerifier } from './pkce';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_TIMEOUT_MS = 3 * 60 * 1000;

export interface GoogleSignInInput {
  clientId: string;
  clientSecret?: string;
}

export interface GoogleSignInDeps {
  /** `shell.openExternal` in the app. */
  openExternal(url: string): Promise<void> | void;
  /** `net.fetch` in the app (honours the system proxy). */
  fetch: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  authEndpoint?: string;
  tokenEndpoint?: string;
}

export function authorizationUrl(p: { endpoint?: string; clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(p.endpoint ?? GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export async function signInWithGoogle(input: GoogleSignInInput, deps: GoogleSignInDeps): Promise<{ id_token: string }> {
  const clientId = input.clientId.trim();
  if (!clientId) throw new AuthFlowError('failed', 'no Google client id');
  const verifier = createVerifier();
  const state = createState();
  const loopback = await startLoopback({ state, timeoutMs: deps.timeoutMs ?? GOOGLE_TIMEOUT_MS, signal: deps.signal });
  try {
    await deps.openExternal(authorizationUrl({ endpoint: deps.authEndpoint, clientId, redirectUri: loopback.redirectUri, challenge: challengeFor(verifier), state }));
    const code = await loopback.code;

    const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier, redirect_uri: loopback.redirectUri });
    if (input.clientSecret) form.set('client_secret', input.clientSecret);
    let res: Response;
    try {
      res = await deps.fetch(deps.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), signal: deps.signal });
    } catch {
      throw new AuthFlowError(deps.signal?.aborted ? 'cancelled' : 'failed', 'could not reach Google');
    }
    const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown; error_description?: unknown };
    if (!res.ok || typeof body.id_token !== 'string' || !body.id_token) {
      // Google's own error text ("client_secret is missing.") names no secret value; safe to pass on.
      const why = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `token endpoint answered ${res.status}`;
      throw new AuthFlowError('failed', why);
    }
    return { id_token: body.id_token };
  } catch (e) {
    throw e instanceof AuthFlowError ? e : new AuthFlowError('failed', e instanceof Error ? e.message : 'sign-in failed');
  } finally {
    loopback.close();
  }
}
