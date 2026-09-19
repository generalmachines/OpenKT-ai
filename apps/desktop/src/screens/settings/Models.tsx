import { useEffect, useState } from 'react';
import { useClient, useQuery } from '../../api/hooks';
import { ErrorNote, Loading } from '../../components/bits';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';

/** Models.dc.html, with the decided model line-up (docs/architecture.md §5). */
export function Models() {
  const client = useClient();
  const settings = useQuery((c) => c.getModelSettings(), []);
  const [endpoint, setEndpoint] = useState('');
  const saved = settings.data?.endpoint ?? '';

  useEffect(() => setEndpoint(saved), [saved]);

  const commit = () => {
    if (endpoint.trim() !== saved) void client.setModelEndpoint(endpoint);
  };

  return (
    <>
      <h1 className="h1 h1--sm">Models</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        Everything here runs on this Mac. Swap any of them, or point a job at your own endpoint.
      </p>
      {settings.loading && !settings.data && <Loading />}
      {settings.error && <ErrorNote error={settings.error} />}
      <ul className="plain">
        {(settings.data?.models ?? []).map((m) => (
          <li key={m.job} className="mdl">
            <span className="mdl__job">{m.jobLabel}</span>
            <span className="person__text">
              <span className="mdl__name">{m.name}</span>
              <span className="person__sub mono">{m.meta}</span>
            </span>
            <Select
              label={`Model for ${m.jobLabel}`}
              value={m.name}
              display="Change"
              options={m.alternatives.map((a) => ({ value: a, label: a }))}
              onChange={(v) => void client.setModel(m.job, v)}
            />
            {m.state === 'ready' ? (
              <span className="conn__state mono" style={{ width: 84 }}>
                <Icon name="check" size={13} />
                ready
              </span>
            ) : (
              <span className="mdl__progress mono">downloading {m.state.downloading}%</span>
            )}
          </li>
        ))}
      </ul>
      <div style={{ height: 18, flexShrink: 0 }} />
      <div className="card card--row">
        <span className="card__text">
          <span className="card__title">Use my own endpoint</span>
          <span className="card__desc">Any OpenAI-compatible server — Ollama, LM Studio, or one your team hosts.</span>
        </span>
        <label htmlFor="ep" className="sr-only">
          Endpoint URL
        </label>
        <input
          id="ep"
          type="text"
          className="input"
          style={{ width: 280, fontSize: 13.5, flexGrow: 0 }}
          placeholder="http://localhost:11434/v1"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </div>
      {saved && (
        <p className="mono small-meta" role="status" style={{ margin: '6px 2px 0' }}>
          understanding and images now go to {saved}
        </p>
      )}
    </>
  );
}
