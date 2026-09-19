import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_SERVER_URL, type ApiSettings } from '../../api';
import { useClient, useQuery } from '../../api/hooks';
import { Avatar, ErrorNote } from '../../components/bits';
import { Select } from '../../components/Select';
import { useConnection } from '../../state/connection';

/** No artboard. Holds the adapter switch: sample data or a real server. */
export function Workspace() {
  const client = useClient();
  const navigate = useNavigate();
  const { settings, connect } = useConnection();
  const workspace = useQuery((c) => c.getWorkspace(), []);
  const [adapter, setAdapter] = useState<ApiSettings['adapter']>(settings.adapter);
  const changed = adapter !== settings.adapter;

  const apply = async () => {
    if (adapter === 'mock') return connect({ ...settings, adapter: 'mock' });
    // Going to a server needs an address and a token that were checked: that is the Connect screen's job.
    if (!settings.token) return navigate('/connect');
    return connect({ ...settings, adapter: 'http' });
  };

  return (
    <>
      <h1 className="h1 h1--sm">Workspace</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {workspace.data ? `${workspace.data.name} · ${workspace.data.people.filter((p) => !p.external).length} people. ` : ' '}
        The app has no backend of its own; it talks to your team’s server.
      </p>
      <ul className="plain">
        <li className="mdl">
          <span className="mdl__job">Data</span>
          <span className="person__text">
            <span className="mdl__name">{adapter === 'mock' ? 'Sample data' : 'OpenKT server'}</span>
            <span className="person__sub mono">{adapter === 'mock' ? 'in memory · resets when the app restarts' : settings.baseUrl || DEFAULT_SERVER_URL}</span>
          </span>
          <Select
            label="Data source"
            value={adapter}
            options={[
              { value: 'mock', label: 'Sample data' },
              { value: 'http', label: 'OpenKT server' },
            ]}
            onChange={setAdapter}
            style={{ minWidth: 150 }}
          />
        </li>
      </ul>
      <div className="formfoot">
        <span className="mono small-meta" role="status">
          now using {client.kind === 'mock' ? 'sample data' : 'your server'} · server and token live under Account
        </span>
        <button type="button" className="btn btn--dark btn--box" disabled={!changed} onClick={() => void apply()}>
          {adapter === 'http' && !settings.token ? 'Connect a server…' : 'Apply'}
        </button>
      </div>
    </>
  );
}

export function Account() {
  const client = useClient();
  const navigate = useNavigate();
  const { settings, signOut } = useConnection();
  const me = useQuery((c) => c.getMe(), []);
  const onServer = client.kind === 'http';

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
              <span className="person__sub mono">{onServer ? me.data.email || 'signed in with an access token' : 'sample account · not signed in anywhere'}</span>
            </span>
            {onServer ? (
              <button type="button" className="btn btn--box-sm" onClick={() => void signOut().then(() => navigate('/connect'))}>
                Sign out
              </button>
            ) : (
              <button type="button" className="btn btn--box-sm" onClick={() => navigate('/connect')}>
                Connect a server
              </button>
            )}
          </li>
        )}
        <li className="mdl">
          <span className="mdl__job">Server</span>
          <span className="person__text">
            <span className="mdl__name mono" style={{ fontSize: 13 }}>
              {onServer ? settings.baseUrl : 'none — sample data'}
            </span>
            <span className="person__sub mono">
              {onServer ? `token ${window.openkt ? 'kept in the macOS keychain' : 'kept in this browser'} · sign out to change either` : 'nothing leaves this Mac'}
            </span>
          </span>
        </li>
      </ul>
    </>
  );
}
