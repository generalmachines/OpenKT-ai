import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_SERVER_URL, MIN_PASSWORD_LENGTH, createAuth, describeAuthError, onboarding, type AuthProviders, type AuthSession } from '../api';
import { MockAuth, type AuthMode } from '../api/auth';
import { GoogleSignInError, googleAuth } from '../api/bridge';
import { HttpClient } from '../api/http';
import { looksLikeEmail } from '../components/AccessPanel';
import { useConnection } from '../state/connection';

/** Accepts "host:3300" as typed; the scheme is only assumed, never rewritten once present. */
export function normalizeServerUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  // A bare host on a private network is almost never behind TLS; a public name almost always is.
  return /^(localhost|127\.|10\.|192\.168\.|[^/]*\.(local|ts\.net)\b)|:\d+$/i.test(v) ? `http://${v}` : `https://${v}`;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

const Spinner = () => <span className="spinner" aria-hidden="true" />;

/**
 * First run, after signing out, and whenever the session ends. One calm card:
 * Google, or email and password; the same card becomes "create an account".
 * Self-hosters find their server address (and the access-token path) behind
 * the quiet link at the bottom — nobody else ever sees those words.
 */
export function Welcome() {
  const { settings, expired, connect } = useConnection();
  const navigate = useNavigate();
  const { search } = useLocation();

  const remembered = settings.baseUrl && settings.baseUrl !== DEFAULT_SERVER_URL ? settings.baseUrl : '';
  // "Sign up" on the sample workspace's banner opens straight into creating an account.
  const [mode, setMode] = useState<'signin' | 'signup'>(() => (new URLSearchParams(search).get('mode') === 'signup' ? 'signup' : 'signin'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState(settings.email ?? '');
  const [password, setPassword] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [server, setServer] = useState(remembered);
  const [withToken, setWithToken] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'form' | 'google' | null>(null);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      googleAuth.cancel();
    },
    [],
  );

  const custom = normalizeServerUrl(server);
  const customServer = Boolean(custom) && custom !== DEFAULT_SERVER_URL;
  const baseUrl = custom || DEFAULT_SERVER_URL;
  const auth = useMemo(() => createAuth({ adapter: settings.adapter, baseUrl }, customServer), [settings.adapter, baseUrl, customServer]);
  const sample = auth instanceof MockAuth;

  // Which buttons to offer. Asked again (a beat after typing stops) when the server address changes.
  useEffect(() => {
    let live = true;
    setProviders(null);
    const t = setTimeout(() => void auth.providers().then((p) => live && setProviders(p), () => undefined), customServer ? 400 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [auth, customServer]);

  const showGoogle = !withToken && providers?.google.enabled === true && (sample || googleAuth.available());

  const finish = async (session: AuthSession, firstTimeHere: boolean) => {
    await connect({ adapter: sample ? 'mock' : 'http', baseUrl, token: sample ? '' : session.token, email: session.user.email || email.trim(), signedOut: false });
    if (!alive.current) return;
    // New people connect their tools and fetch the models first; everyone else lands on their sessions.
    navigate(session.isNew || firstTimeHere ? '/onboarding/2' : '/', { replace: true });
  };

  const fail = (e: unknown, m: AuthMode) => alive.current && setError(describeAuthError(e, m, customServer));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (withToken) return submitToken();
    const address = email.trim();
    if (mode === 'signup' && !name.trim()) return setError('Enter your name.');
    if (!address) return setError('Enter your email address.');
    if (!looksLikeEmail(address)) return setError('That email address doesn’t look right.');
    if (!password) return setError(mode === 'signup' ? 'Choose a password.' : 'Enter your password.');
    if (mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) return setError(`Choose a longer password — at least ${MIN_PASSWORD_LENGTH} characters.`);
    setBusy('form');
    setError('');
    try {
      await finish(mode === 'signup' ? await auth.signUp({ email: address, password, name: name.trim() }) : await auth.logIn({ email: address, password }), false);
    } catch (err) {
      fail(err, mode);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const submitToken = async () => {
    if (!token.trim()) return setError('Paste your access token.');
    setBusy('form');
    setError('');
    try {
      const me = await new HttpClient({ baseUrl, token: token.trim() }).getMe();
      await connect({ adapter: 'http', baseUrl, token: token.trim(), email: me.email || undefined, signedOut: false });
      if (alive.current) navigate('/', { replace: true });
    } catch (err) {
      fail(err, 'token');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const withGoogle = async () => {
    if (busy || !providers) return;
    setBusy('google');
    setError('');
    try {
      const idToken = sample ? '' : await googleAuth.start({ clientId: providers.google.clientId, clientSecret: providers.google.clientSecret });
      await finish(await auth.google(idToken), !onboarding.done());
    } catch (err) {
      if (err instanceof GoogleSignInError) {
        if (err.kind !== 'cancelled' && alive.current) setError(err.kind === 'timeout' ? 'Google sign-in took too long. Try again.' : 'Google sign-in didn’t finish. Try again.');
      } else fail(err, 'google');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const useSample = async () => {
    await connect({ ...settings, adapter: 'mock', token: '', signedOut: false });
    navigate('/', { replace: true });
  };

  const edit =
    (set: (v: string) => void) =>
    (e: { target: { value: string } }) => {
      set(e.target.value);
      setError('');
    };
  const swap = (next: 'signin' | 'signup') => {
    setMode(next);
    setError('');
  };
  const locked = busy !== null;
  const signup = mode === 'signup' && !withToken;

  return (
    <div className="welcome">
      <div className="welcome__drag" aria-hidden="true" />
      <main className="welcome__card">
        <h1 className="welcome__name">OpenKT</h1>
        <p className="welcome__line">Your team’s shared context, in every AI tool.</p>

        {expired && !error && (
          <p className="welcome__notice" role="status">
            Please sign in again.
          </p>
        )}

        {showGoogle && (
          <>
            <button type="button" className="btn welcome__google" onClick={() => void withGoogle()} disabled={locked} aria-busy={busy === 'google'}>
              {busy === 'google' ? <Spinner /> : <GoogleMark />}
              {busy === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
            </button>
            {busy === 'google' && !sample ? (
              <p className="welcome__waiting" role="status">
                Finish signing in in your browser.{' '}
                <button type="button" className="linkbtn" onClick={() => googleAuth.cancel()}>
                  Cancel
                </button>
              </p>
            ) : (
              <div className="welcome__or" role="separator">
                <span>or</span>
              </div>
            )}
          </>
        )}

        <form className="welcome__form" onSubmit={(e) => void submit(e)} noValidate aria-label={withToken ? 'Sign in with an access token' : signup ? 'Create an account' : 'Sign in'}>
          {withToken ? (
            <label className="welcome__field">
              <span className="field__label">Access token</span>
              <input type="password" name="access-token" className="input" value={token} onChange={edit(setToken)} disabled={locked} autoComplete="off" spellCheck={false} autoFocus />
            </label>
          ) : (
            <>
              {signup && (
                <label className="welcome__field">
                  <span className="field__label">Your name</span>
                  <input type="text" name="name" className="input" value={name} onChange={edit(setName)} disabled={locked} autoComplete="name" autoFocus />
                </label>
              )}
              <label className="welcome__field">
                <span className="field__label">Email</span>
                <input type="email" name="email" inputMode="email" className="input" value={email} onChange={edit(setEmail)} disabled={locked} autoComplete="username" spellCheck={false} autoCapitalize="none" autoFocus={!signup && !email} />
              </label>
              <div className="welcome__field">
                <label htmlFor="welcome-password" className="field__label">
                  Password
                </label>
                <input
                  id="welcome-password"
                  type="password"
                  name="password"
                  className="input"
                  value={password}
                  onChange={edit(setPassword)}
                  disabled={locked}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  aria-describedby={signup ? 'welcome-password-hint' : undefined}
                  autoFocus={!signup && Boolean(email)}
                />
                {signup && (
                  <span id="welcome-password-hint" className="welcome__hint">
                    At least {MIN_PASSWORD_LENGTH} characters
                  </span>
                )}
              </div>
            </>
          )}

          {error && (
            <p className="welcome__error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn--accent welcome__submit" disabled={locked} aria-busy={busy === 'form'}>
            {busy === 'form' && <Spinner />}
            {signup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="welcome__switch">
          {withToken ? (
            <button type="button" className="linkbtn" onClick={() => (setWithToken(false), setError(''))}>
              Use email and password instead
            </button>
          ) : signup ? (
            <>
              Already have an account?{' '}
              <button type="button" className="linkbtn" onClick={() => swap('signin')}>
                Sign in
              </button>
            </>
          ) : (
            <>
              New to OpenKT?{' '}
              <button type="button" className="linkbtn" onClick={() => swap('signup')}>
                Create an account
              </button>
            </>
          )}
        </p>

        {!withToken && (
          <div className="welcome__demo-wrap">
            <button type="button" className="btn welcome__demo" onClick={() => void useSample()} disabled={locked}>
              See a demo with sample data
            </button>
            <p className="welcome__demo-note">Six teams’ shared knowledge to look around in. No account needed.</p>
          </div>
        )}
      </main>

      <footer className="welcome__foot">
        {!advanced ? (
          <button type="button" className="welcome__quiet" onClick={() => setAdvanced(true)} aria-expanded="false">
            {remembered && customServer ? `Signing in to ${hostOf(custom)} · Change` : 'Using your own server?'}
          </button>
        ) : (
          <div className="welcome__advanced">
            <div className="welcome__field">
              <span className="welcome__field-head">
                <label htmlFor="welcome-server" className="field__label">
                  Server address
                </label>
                <button type="button" className="welcome__quiet" onClick={() => (setAdvanced(false), setWithToken(false), setServer(''), setError(''))} disabled={locked}>
                  Use OpenKT instead
                </button>
              </span>
              <input id="welcome-server" type="text" name="server" inputMode="url" className="input" placeholder="openkt.yourcompany.com" value={server} onChange={edit(setServer)} disabled={locked} autoComplete="off" spellCheck={false} autoCapitalize="none" autoFocus />
            </div>
            <p className="welcome__advanced-links">
              {!withToken && (
                <button type="button" className="welcome__quiet" onClick={() => (setWithToken(true), setError(''))} disabled={locked}>
                  Sign in with an access token
                </button>
              )}
            </p>
          </div>
        )}
      </footer>
    </div>
  );
}
