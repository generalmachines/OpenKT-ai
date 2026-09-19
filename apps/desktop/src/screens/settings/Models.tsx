import { useEffect, useState } from 'react';
import { models as modelsBridge, type ModelStatus } from '../../api/bridge';
import { useClient, useQuery } from '../../api/hooks';
import { PreviewBadge } from '../../components/PreviewBadge';
import { ErrorNote, Loading } from '../../components/bits';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';

const gb = (bytes?: number) => (bytes ? `${(bytes / 1e9).toFixed(1)} GB` : '');

/** Live rows from the main process: `models.status`, progress events, and a Download button (`models.ensure`). */
function LiveModels({ initial }: { initial: ModelStatus[] }) {
  const [rows, setRows] = useState(initial);

  useEffect(
    () =>
      modelsBridge.onProgress((m) =>
        setRows((prev) => (prev.some((r) => r.id === m.id) ? prev.map((r) => (r.id === m.id ? { ...r, ...m } : r)) : [...prev, m])),
      ),
    [],
  );

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // `ensure` takes no argument: it fetches everything that is missing, embeddings first.
  const download = () => {
    setBusy(true);
    setFailure(null);
    void modelsBridge
      .ensure()
      .then((err) => (setFailure(err), modelsBridge.status()))
      .then((next) => next && setRows(next))
      .finally(() => setBusy(false));
  };
  const missing = rows.filter((r) => r.state !== 'ready');
  const missingBytes = missing.reduce((sum, r) => sum + Math.max(0, (r.bytesTotal ?? 0) - (r.bytesDone ?? 0)), 0);

  return (
    <ul className="plain" aria-label="Models on this Mac">
      {rows.map((m) => (
        <li key={m.id} className="mdl">
          <span className="mdl__job">{m.job}</span>
          <span className="person__text">
            <span className="mdl__name">{m.id}</span>
            <span className="person__sub mono">{m.state === 'error' ? (m.error ?? 'download failed') : [m.file, gb(m.bytesTotal)].filter(Boolean).join(' · ')}</span>
          </span>
          {m.state === 'ready' ? (
            <span className="conn__state mono" style={{ width: 84 }}>
              <Icon name="check" size={13} />
              ready
            </span>
          ) : m.state === 'downloading' || m.state === 'verifying' ? (
            <span className="mdl__progress mono" role="status">
              {m.state === 'verifying' ? 'verifying…' : `downloading ${m.progress ?? 0}%`}
            </span>
          ) : (
            <span className="mdl__progress mono">{m.state === 'error' ? 'failed' : m.state === 'partial' ? `paused at ${m.progress}%` : 'not downloaded'}</span>
          )}
        </li>
      ))}
      {missing.length > 0 && (
        <li className="formfoot" style={{ paddingTop: 12 }}>
          <span className="mono small-meta" role="status">
            {failure ?? (busy ? 'downloading · you can keep working' : `${missing.length} of ${rows.length} not on this Mac yet`)}
          </span>
          <button type="button" className="btn btn--dark btn--box" onClick={download} disabled={busy}>
            {failure ? 'Retry download' : `Download${missingBytes ? ` ${gb(missingBytes)}` : ''}`}
          </button>
        </li>
      )}
    </ul>
  );
}

/** Models.dc.html, with the decided model line-up (docs/architecture.md §5). */
export function Models() {
  const client = useClient();
  const settings = useQuery((c) => c.getModelSettings(), []);
  const [endpoint, setEndpoint] = useState('');
  const saved = settings.data?.endpoint ?? '';
  // undefined: still asking · null: no model IPC (browser, older main) → the static rows below.
  const [live, setLive] = useState<ModelStatus[] | null | undefined>(undefined);
  useEffect(() => void modelsBridge.status().then(setLive), []);

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
      {live === null && <PreviewBadge area="models">Preview — sample data · model downloads need the desktop app</PreviewBadge>}
      {settings.loading && !settings.data && <Loading />}
      {settings.error && <ErrorNote error={settings.error} />}
      {live && live.length > 0 && <LiveModels initial={live} />}
      <ul className="plain" hidden={Boolean(live?.length)}>
        {(live?.length ? [] : (settings.data?.models ?? [])).map((m) => (
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
