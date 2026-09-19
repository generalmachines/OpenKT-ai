import { useClient, useQuery } from '../../api/hooks';
import { ErrorNote, Loading } from '../../components/bits';
import { Icon, SOURCE_ICON } from '../../components/Icon';
import { Select } from '../../components/Select';

const COPY = {
  connectors: {
    title: 'Connectors',
    lede: 'Every conversation in a connected tool becomes a session here. Choose who can use what each tool produces — you can always change a single session later.',
  },
  access: {
    title: 'Access defaults',
    lede: 'Who can use new sessions, tool by tool. A default only applies when a session is created — sharing or narrowing one session later never changes the rule.',
  },
} as const;

/** Connectors.dc.html. "Access defaults" is the same table read from the access side. */
export function Connectors({ mode }: { mode: 'connectors' | 'access' }) {
  const client = useClient();
  const connectors = useQuery((c) => c.listConnectors(), []);
  const defaults = useQuery((c) => c.listAccessDefaults(), []);
  const options = (defaults.data ?? []).map((d) => ({ value: d.id, label: d.label }));
  const rows = (connectors.data ?? []).filter((c) => (mode === 'access' ? c.connected : true));

  return (
    <>
      <h1 className="h1 h1--sm">{COPY[mode].title}</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {COPY[mode].lede}
      </p>
      <div className="thead mono">
        <span className="thead__tool">tool</span>
        <span style={{ width: 218 }}>new sessions are shared with</span>
        <span style={{ width: 96 }} />
      </div>
      {connectors.loading && !connectors.data && <Loading />}
      {connectors.error && <ErrorNote error={connectors.error} />}
      <ul className="plain">
        {rows.map((c) => (
          <li key={c.id} className="conn">
            <span className="conn__icon">
              <Icon name={SOURCE_ICON[c.source]} size={17} />
            </span>
            <span className="person__text">
              <span className="person__name">{c.name}</span>
              <span className="person__sub mono">{c.detail}</span>
            </span>
            <Select
              label={`New ${c.name} sessions are shared with`}
              value={c.defaultAccess}
              options={options}
              muted={!c.connected}
              onChange={(v) => void client.updateConnector(c.id, { defaultAccess: v })}
              style={{ width: 218 }}
            />
            {c.connected ? (
              <span className="conn__state mono">
                <Icon name="check" size={13} />
                connected
              </span>
            ) : (
              <button type="button" className="btn btn--box-sm" style={{ width: 96 }} onClick={() => void client.updateConnector(c.id, { connected: true })}>
                Connect
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
