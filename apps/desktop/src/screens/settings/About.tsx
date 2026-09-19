import { useEffect, useState } from 'react';
import { formatBytes, useUpdateStatus, type UpdateStatus } from '../../api/updates';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return 'never';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function built(s: UpdateStatus): string {
  const parts = [s.commit ? `commit ${s.commit.slice(0, 7)}` : 'built from source', s.builtAt ? `built ${new Date(s.builtAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''];
  return parts.filter(Boolean).join(' · ');
}

/** One line saying where the updater is, in words. */
function summary(s: UpdateStatus): string {
  const v = s.available?.version;
  switch (s.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `OpenKT ${v} is available${s.available ? ` · ${formatBytes(s.available.size)}` : ''}`;
    case 'downloading': {
      const p = s.progress;
      const pct = p && p.totalBytes ? Math.floor((p.receivedBytes / p.totalBytes) * 100) : 0;
      return `Downloading ${v} · ${pct}%`;
    }
    case 'verifying':
      return `Checking the download of ${v}…`;
    case 'ready':
      return `OpenKT ${v} is ready to install`;
    case 'installing':
      return 'Restarting to update…';
    case 'error':
      return 'The last update check did not finish';
    case 'up-to-date':
      return 'You have the latest version';
    default:
      return s.mode === 'disabled' ? 'This build does not update itself' : 'Updates are checked automatically';
  }
}

function Progress({ s }: { s: UpdateStatus }) {
  const p = s.progress;
  const pct = p && p.totalBytes ? Math.min(100, (p.receivedBytes / p.totalBytes) * 100) : 0;
  return (
    <div className="upd__bar" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(pct)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Settings → About: the running version and in-app updates (src/main/update). */
export function About() {
  const { status: s, run } = useUpdateStatus();
  const [busy, setBusy] = useState(false);
  const [whatsNew, setWhatsNew] = useState<UpdateStatus['whatsNew']>(null);

  // "Updated to X — what's new" is shown once: keep it on screen here, tell main it has been seen.
  useEffect(() => {
    if (s?.whatsNew) {
      setWhatsNew(s.whatsNew);
      void run('seen');
    }
  }, [s?.whatsNew, run]);

  const act = (a: Parameters<typeof run>[0]) => {
    setBusy(true);
    void run(a).finally(() => setBusy(false));
  };

  if (s === undefined) return <p className="state mono">loading…</p>;

  if (s === null) {
    return (
      <>
        <h1 className="h1 h1--sm">About</h1>
        <p className="lede" style={{ maxWidth: 560 }}>
          Version details and updates come from the OpenKT desktop app. This window is not running inside it.
        </p>
      </>
    );
  }

  const checking = s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing';
  const notes = s.available?.notes ?? [];

  return (
    <>
      <h1 className="h1 h1--sm">About</h1>
      <p className="lede" style={{ maxWidth: 560, marginBottom: 14 }}>
        OpenKT keeps itself up to date. New versions download in the background and install when you restart.
      </p>

      <ul className="plain">
        <li className="mdl">
          <span className="mdl__job">Version</span>
          <span className="person__text">
            <span className="mdl__name">OpenKT {s.version}</span>
            <span className="person__sub mono">{built(s)}</span>
          </span>
          <span className="mdl__progress mono">{s.channel}</span>
        </li>
      </ul>

      {whatsNew && (
        <section className="card upd__card" aria-label={`Updated to ${whatsNew.version}`}>
          <span className="card__title">Updated to {whatsNew.version} — what’s new</span>
          {whatsNew.notes.length > 0 ? (
            <ul className="upd__notes">
              {whatsNew.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <span className="card__desc">Fixes and improvements since {whatsNew.from}.</span>
          )}
        </section>
      )}

      {s.rollback && (
        <div className="card card--row upd__card">
          <span className="card__text">
            <span className="card__title">OpenKT {s.rollback.from} did not start properly</span>
            <span className="card__desc">You can go back to {s.rollback.to}, the version you had before. {s.rollback.from} will not be offered again.</span>
          </span>
          <button type="button" className="btn btn--box-sm" onClick={() => act('rollback')} disabled={busy}>
            Go back to {s.rollback.to}
          </button>
        </div>
      )}

      {!s.location.ok && s.mode !== 'disabled' && (
        <div className="card card--row upd__card">
          <span className="card__text">
            <span className="card__title">Move OpenKT to Applications</span>
            <span className="card__desc">{s.location.message}</span>
          </span>
          {s.location.canMove && (
            <button type="button" className="btn btn--dark btn--box-sm" onClick={() => act('moveToApplications')} disabled={busy}>
              Move to Applications
            </button>
          )}
        </div>
      )}

      <section className="card upd__card" aria-label="Updates">
        <div className="upd__row">
          <span className="card__text">
            <span className="card__title" role="status">
              {summary(s)}
            </span>
            <span className="card__desc mono small-meta">
              last checked {ago(s.lastCheckedAt)}
              {s.mode === 'signed' ? ' · signed build' : ''}
            </span>
          </span>
          {s.phase === 'ready' ? (
            <button type="button" className="btn btn--dark btn--box-sm" onClick={() => act('install')} disabled={busy || !s.location.ok}>
              Restart to update
            </button>
          ) : s.phase === 'available' && !s.auto ? (
            <button type="button" className="btn btn--box-sm" onClick={() => act('download')} disabled={busy || !s.location.ok}>
              Download
            </button>
          ) : (
            <button type="button" className="btn btn--box-sm" onClick={() => act('check')} disabled={busy || checking}>
              {s.phase === 'error' ? 'Try again' : 'Check now'}
            </button>
          )}
        </div>
        {s.phase === 'downloading' && <Progress s={s} />}
        {s.error && (
          <p className="upd__error" role="alert">
            {s.error}
          </p>
        )}
        {s.available && notes.length > 0 && (
          <div>
            <p className="caps">What’s in {s.available.version}</p>
            <ul className="upd__notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="card card--row upd__card">
        <span className="card__text">
          <span className="card__title" id="upd-auto">
            Download updates automatically
          </span>
          <span className="card__desc">When this is off, OpenKT still checks, and asks before it downloads anything.</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={s.auto}
          aria-labelledby="upd-auto"
          className="switch"
          onClick={() => act(s.auto ? 'auto-off' : 'auto-on')}
          disabled={busy}
        >
          <span className="switch__knob" />
        </button>
      </div>
    </>
  );
}
