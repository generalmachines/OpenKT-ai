import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_SERVER_URL, type ApiSettings } from '../../api';
import { useClient, useQuery } from '../../api/hooks';
import { Avatar, ErrorNote } from '../../components/bits';
import { Select } from '../../components/Select';
import { useConnection } from '../../state/connection';

/** No artboard. Which data the app shows: the person's account, or the built-in sample. */
export function Workspace() {
  const client = useClient();
  const navigate = useNavigate();
  const { settings, connect } = useConnection();
  const workspace = useQuery((c) => c.getWorkspace(), []);
  const [adapter, setAdapter] = useState<ApiSettings['adapter']>(settings.adapter);
  const changed = adapter !== settings.adapter;

  const apply = async () => {
    if (adapter === 'mock') return connect({ ...settings, adapter: 'mock', signedOut: false });
    // Leaving sample data means signing in: that is the Welcome screen's job.
    if (!settings.token) return navigate('/welcome');
    return connect({ ...settings, adapter: 'http' });
  };

  return (
    <>
      <h1 className="h1 h1--sm">Workspace</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {workspace.data ? `${workspace.data.name} · ${workspace.data.people.filter((p) => !p.external).length} people.` : ' '}
      </p>
      <ul className="plain">
        <li className="mdl">
          <span className="mdl__job">Data</span>
          <span className="person__text">
            <span className="mdl__name">{adapter === 'mock' ? 'Sample data' : 'Your account'}</span>
            <span className="person__sub mono">{adapter === 'mock' ? 'on this Mac only · resets when the app restarts' : 'everything you and your team have saved'}</span>
          </span>
          <Select
            label="Data source"
            value={adapter}
            options={[
              { value: 'mock', label: 'Sample data' },
              { value: 'http', label: 'Your account' },
            ]}
            onChange={setAdapter}
            style={{ minWidth: 150 }}
          />
        </li>
      </ul>
      <div className="formfoot">
        <span className="mono small-meta" role="status">
          now showing {client.kind === 'mock' ? 'sample data' : 'your account'}
        </span>
        <button type="button" className="btn btn--dark btn--box" disabled={!changed} onClick={() => void apply()}>
          {adapter === 'http' && !settings.token ? 'Sign in…' : 'Apply'}
        </button>
      </div>
    </>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Name, email, Sign out. The server is only mentioned to people who chose their own. */
export function Account() {
  const client = useClient();
  const navigate = useNavigate();
  const { settings, signOut } = useConnection();
  const me = useQuery((c) => c.getMe(), []);
  const [leaving, setLeaving] = useState(false);
  const ownServer = client.kind === 'http' && Boolean(settings.baseUrl) && settings.baseUrl !== DEFAULT_SERVER_URL;

  const leave = async () => {
    setLeaving(true);
    await signOut();
    navigate('/welcome', { replace: true });
  };

  return (
    <>
      <h1 className="h1 h1--sm">Account</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        Everything you capture is attributed to you, and private to you until you share it.
      </p>
      {me.error && <ErrorNote error={me.error} />}
      <ul className="plain">
        {me.data && (
          <li className="person">
            <Avatar initials={me.data.initials} />
            <span className="person__text">
              <span className="person__name">{me.data.name}</span>
              <span className="person__sub mono">{[me.data.email || settings.email, client.kind === 'mock' ? 'sample account' : ''].filter(Boolean).join(' · ')}</span>
            </span>
            <button type="button" className="btn btn--box-sm" onClick={() => void leave()} disabled={leaving}>
              Sign out
            </button>
          </li>
        )}
        {ownServer && (
          <li className="mdl">
            <span className="mdl__job">Server</span>
            <span className="person__text">
              <span className="mdl__name">{hostOf(settings.baseUrl)}</span>
              <span className="person__sub mono">your own server · sign out to change it</span>
            </span>
          </li>
        )}
      </ul>
    </>
  );
}
