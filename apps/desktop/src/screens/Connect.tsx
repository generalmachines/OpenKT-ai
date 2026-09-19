import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_SERVER_URL, TOKEN_PREFIX, describeError, type Me } from '../api';
import { HttpClient } from '../api/http';
import { Avatar } from '../components/bits';
import { Icon } from '../components/Icon';
import { useConnection } from '../state/connection';

type Check = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; me: Me; spaces: number } | { state: 'failed'; message: string };

/** Accepts "host:3300" as typed; the scheme is only assumed, never rewritten once present. */
export function normalizeServerUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}

/**
 * First run, and whenever the token is missing or refused. Borrows the
 * onboarding frame (Onboarding.dc.html): the rail says where you are, the
 * right side is one form.
 */
export function Connect() {
  const { settings, expired, connect } = useConnection();
  const navigate = useNavigate();
  const [url, setUrl] = useState(settings.baseUrl || DEFAULT_SERVER_URL);
  const [token, setToken] = useState(settings.token);
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  const baseUrl = normalizeServerUrl(url);
  const ready = Boolean(baseUrl && token.trim());
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setCheck({ state: 'idle' });
    };

  const test = async (): Promise<boolean> => {
    setCheck({ state: 'testing' });
    try {
      const probe = new HttpClient({ baseUrl, token });
      const me = await probe.getMe();
      const spaces = (await probe.listSpaces()).length;
      setCheck({ state: 'ok', me, spaces });
      return true;
    } catch (e) {
      setCheck({ state: 'failed', message: describeError(e) });
      return false;
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (check.state !== 'ok' && !(await test())) return;
    await connect({ adapter: 'http', baseUrl, token: token.trim() });
    navigate('/', { replace: true });
  };

  const useSample = async () => {
    await connect({
      adapter: 'mock',
      baseUrl: baseUrl || DEFAULT_SERVER_URL,
      token: '',
    });
    navigate('/', { replace: true });
  };

  return (
    <div className="onb">
      <aside className="onb__rail">
        <div className="sidebar__drag" aria-hidden="true" />
        <span className="onb__name">OpenKT</span>
        <h1 className="onb__h1">Connect to your team’s server.</h1>
        <ol className="plain onb__steps">
          <li className="step step--now" aria-current="step">
            <span className="step__mark mono">1</span>
            <span className="step__text">
              <span className="step__title">Server and token</span>
              <span className="step__detail">The app has no backend of its own. Everything you capture is filed on the server you name here.</span>
            </span>
          </li>
          <li className="step step--todo">
            <span className="step__mark mono">2</span>
            <span className="step__text">
              <span className="step__title">Start capturing</span>
              <span className="step__detail">Write a note, or hold fn and say it. It lands in your personal space until you share it.</span>
            </span>
          </li>
        </ol>
      </aside>
      <form className="onb__main" onSubmit={save}>
        <h2 className="onb__h2">Connect to a server</h2>
        <p className="lede onb__lede">
          {expired
            ? 'The server no longer accepts the saved token. Paste a new one to carry on.'
            : 'Paste the address of your OpenKT server and a personal access token. Whoever runs the server can issue one; it starts with okt_pat_.'}
        </p>
        <label htmlFor="cn-url" className="field__label">
          Server URL
        </label>
        <input
          id="cn-url"
          type="text"
          inputMode="url"
          className="input input--tall mono"
          style={{ maxWidth: 520, flexGrow: 0, fontSize: 13 }}
          placeholder={DEFAULT_SERVER_URL}
          value={url}
          onChange={(e) => edit(setUrl)(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <label htmlFor="cn-token" className="field__label">
          Access token
        </label>
        <input
          id="cn-token"
          type="password"
          className="input input--tall mono"
          style={{ maxWidth: 520, flexGrow: 0, fontSize: 13 }}
          placeholder={`${TOKEN_PREFIX}…`}
          value={token}
          onChange={(e) => edit(setToken)(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />

        <div className="connect__result" role="status" aria-live="polite">
          {check.state === 'testing' && <span className="mono small-meta">asking {baseUrl}/v1/me …</span>}
          {check.state === 'failed' && (
            <span className="connect__failed" role="alert">
              {check.message}
            </span>
          )}
          {check.state === 'ok' && (
            <span className="person" style={{ maxWidth: 520 }}>
              <Avatar initials={check.me.initials} />
              <span className="person__text">
                <span className="person__name">{check.me.name}</span>
                <span className="person__sub mono">
                  {check.me.email || 'signed in'} · {check.spaces} {check.spaces === 1 ? 'space' : 'spaces'}
                </span>
              </span>
              <span className="conn__state mono">
                <Icon name="check" size={13} />
                connected
              </span>
            </span>
          )}
        </div>

        <div className="grow" />
        <div className="onb__foot">
          <span className="onb__note">
            No server yet?{' '}
            <button type="button" className="linkbtn" onClick={() => void useSample()}>
              Look around with sample data
            </button>
          </span>
          <button type="button" className="btn btn--box" onClick={() => void test()} disabled={!ready || check.state === 'testing'}>
            Test connection
          </button>
          <button type="submit" className="btn btn--accent" disabled={!ready || check.state === 'testing'}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
