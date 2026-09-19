import { useState } from 'react';
import { loadApiSettings, saveApiSettings, type ApiSettings } from '../../api';
import { useClient, useQuery } from '../../api/hooks';
import { Avatar } from '../../components/bits';
import { Select } from '../../components/Select';

/** No artboard. Holds the adapter switch: mock data or a real server. */
export function Workspace() {
  const client = useClient();
  const workspace = useQuery((c) => c.getWorkspace(), []);
  const [api, setApi] = useState<ApiSettings>(() => loadApiSettings());
  const [saved, setSaved] = useState(false);
  const patch = (p: Partial<ApiSettings>) => {
    setApi((a) => ({ ...a, ...p }));
    setSaved(false);
  };

  return (
    <>
      <h1 className="h1 h1--sm">Workspace</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {workspace.data ? `${workspace.data.name} · ${workspace.data.people.filter((p) => !p.external).length} people · ${workspace.data.teams.length} teams.` : ' '} The app has no backend of its own; it talks to your team’s server.
      </p>
      <ul className="plain">
        <li className="mdl">
          <span className="mdl__job">Data</span>
          <span className="person__text">
            <span className="mdl__name">{api.adapter === 'mock' ? 'Sample data' : 'OpenKT server'}</span>
            <span className="person__sub mono">{api.adapter === 'mock' ? 'in memory · resets when the app restarts' : 'http adapter · untested against a live server'}</span>
          </span>
          <Select
            label="Data source"
            value={api.adapter}
            options={[
              { value: 'mock', label: 'Sample data' },
              { value: 'http', label: 'OpenKT server' },
            ]}
            onChange={(v) => patch({ adapter: v })}
            style={{ minWidth: 150 }}
          />
        </li>
        <li className="mdl">
          <label className="mdl__job" htmlFor="ws-url">
            Server
          </label>
          <input id="ws-url" className="input" style={{ fontSize: 13.5 }} placeholder="https://openkt.example.com" value={api.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} disabled={api.adapter === 'mock'} />
        </li>
        <li className="mdl">
          <label className="mdl__job" htmlFor="ws-token">
            Access token
          </label>
          <input id="ws-token" type="password" className="input" style={{ fontSize: 13.5 }} placeholder="kt_…" value={api.token} onChange={(e) => patch({ token: e.target.value })} disabled={api.adapter === 'mock'} autoComplete="off" />
        </li>
      </ul>
      <div className="formfoot">
        <span className="mono small-meta" role="status">
          {saved ? 'saved · reloading applies it' : `now using ${client.kind === 'mock' ? 'sample data' : 'your server'}`}
        </span>
        <button
          type="button"
          className="btn btn--dark btn--box"
          onClick={() => {
            saveApiSettings(api);
            setSaved(true);
            window.location.reload();
          }}
        >
          Save and reload
        </button>
      </div>
    </>
  );
}

export function Account() {
  const workspace = useQuery((c) => c.getWorkspace(), []);
  const me = workspace.data?.me;
  return (
    <>
      <h1 className="h1 h1--sm">Account</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        Everything you capture is attributed to you, and private to you until you share it.
      </p>
      {me && (
        <ul className="plain">
          <li className="person">
            <Avatar initials={me.initials} />
            <span className="person__text">
              <span className="person__name">{me.name}</span>
              <span className="person__sub mono">signed in to {workspace.data?.name.toLowerCase()}</span>
            </span>
            <button type="button" className="btn btn--box-sm" disabled title="Sign-in arrives with the server">
              Sign out
            </button>
          </li>
        </ul>
      )}
    </>
  );
}
