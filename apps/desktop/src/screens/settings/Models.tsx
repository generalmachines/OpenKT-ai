import { useEffect, useState } from 'react';
import { useClient, useQuery } from '../../api/hooks';
import { ModelsSetup } from '../../components/ModelsSetup';
import { PreviewBadge } from '../../components/PreviewBadge';
import { ErrorNote, Loading } from '../../components/bits';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { WorkerCard } from '../../components/WorkerCard';
import { modelsSetup } from '../../api/setup-bridge';
import { useModelsSetup } from '../../onboarding/models';

/**
 * The reminder next to "Models" in the settings nav while the on-device AI is not on this Mac and
 * nothing is downloading (the person chose Later, or paused). Re-read on every section change.
 */
export function ModelsChip({ section }: { section: string }) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let live = true;
    void modelsSetup.status().then((rows) => {
      if (!live) return;
      const moving = rows?.some((r) => r.state === 'downloading' || r.state === 'verifying');
      setWaiting(Boolean(rows?.length && !moving && rows.some((r) => r.state !== 'ready')));
    });
    return () => {
      live = false;
    };
  }, [section]);
  if (!waiting) return null;
  return (
    <span className="setnav__chip mono" aria-label="On-device AI not downloaded">
      not set up
    </span>
  );
}

/** Models.dc.html, with the decided model line-up (docs/architecture.md §5). */
export function Models() {
  const client = useClient();
  const settings = useQuery((c) => c.getModelSettings(), []);
  const [endpoint, setEndpoint] = useState('');
  const saved = settings.data?.endpoint ?? '';
  // The desktop app: the same live download as the first-run screen. Without it (a browser): the static rows below.
  const setup = useModelsSetup();
  const live = setup.phase === 'checking' ? undefined : setup.phase === 'unavailable' ? null : setup.rows;

  useEffect(() => setEndpoint(saved), [saved]);

  const commit = () => {
    if (endpoint.trim() !== saved) void client.setModelEndpoint(endpoint);
  };

  return (
    <>
      <h1 className="h1 h1--sm">Models</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        {live === null
          ? 'Everything here runs on this Mac. Swap any of them, or point a job at your own endpoint.'
          : 'Everything here runs on this Mac. It is downloaded once and checked before it is used.'}
      </p>
      {live === null && <PreviewBadge area="models">Preview — sample data · model downloads need the desktop app</PreviewBadge>}
      {settings.loading && !settings.data && <Loading />}
      {settings.error && <ErrorNote error={settings.error} />}
      {live && <WorkerCard />}
      {live && live.length > 0 && <ModelsSetup setup={setup} />}
      <ul className="plain" hidden={Boolean(live?.length)}>
        {(live === null ? (settings.data?.models ?? []) : []).map((m) => (
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
      {/* Not wired to the local runtime yet, so the desktop app does not offer it (it would only pretend). */}
      {live === null && (
        <>
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
      )}
    </>
  );
}
