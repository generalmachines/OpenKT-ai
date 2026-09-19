import { etaSeconds, formatBytes, formatEta, formatSpeed, plainError, ROLE_COPY, speed, totals, type ModelRow, type ModelsSetupState } from '../onboarding/models';
import { Icon } from './Icon';

const pct = (r: ModelRow) => (r.state === 'ready' ? 100 : r.totalBytes > 0 ? Math.min(99, Math.floor((r.receivedBytes / r.totalBytes) * 100)) : 0);

function rowState(r: ModelRow, moving: boolean): string {
  switch (r.state) {
    case 'ready':
      return 'ready';
    case 'downloading':
      return `${pct(r)}% · ${formatBytes(r.receivedBytes)} of ${formatBytes(r.totalBytes)}`;
    case 'verifying':
      return 'checking the file…';
    case 'error':
      return 'stopped';
    case 'partial':
      return moving ? `waiting · ${pct(r)}% here` : `paused at ${pct(r)}%`;
    case 'missing':
      return moving ? `waiting · ${formatBytes(r.totalBytes)}` : formatBytes(r.totalBytes);
  }
}

function ModelLine({ row, moving }: { row: ModelRow; moving: boolean }) {
  const copy = ROLE_COPY[row.role];
  const failed = row.state === 'error';
  return (
    <li className={`dl setup__row setup__row--${row.state}`}>
      <span className="person__text">
        <span className="person__name">{copy.name}</span>
        <span className="person__sub" title={failed ? row.error : undefined}>
          {failed ? plainError(row.error) : copy.why}
        </span>
      </span>
      <span className="mono small-meta dl__state">
        {row.state === 'ready' ? (
          <span className="conn__state" style={{ width: 'auto' }}>
            <Icon name="check" size={13} />
            ready
          </span>
        ) : (
          rowState(row, moving)
        )}
      </span>
      <span
        className="dl__bar"
        role="progressbar"
        aria-label={`${copy.name} download`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct(row)}
      >
        <span style={{ width: `${pct(row)}%` }} />
      </span>
    </li>
  );
}

/**
 * The on-device AI download: total up front, one real bar per model, speed and time left,
 * pause / resume / try again, the disk check and the smaller-model note — the same on the
 * first-run screen and in Settings → Models.
 */
export function ModelsSetup({ setup, onStart }: { setup: ModelsSetupState; onStart?: () => void }) {
  const { rows, info, phase, percent } = setup;
  if (phase === 'checking') return <p className="state mono">checking this Mac…</p>;
  if (phase === 'unavailable' || !rows) {
    return (
      <div className="card card--row setup__card">
        <span className="card__text">
          <span className="card__title">Set up by the desktop app</span>
          <span className="card__desc">The on-device AI is downloaded and run by OpenKT for Mac. Open the app to set it up.</span>
        </span>
      </div>
    );
  }

  const t = totals(rows);
  const moving = phase === 'downloading';
  const eta = etaSeconds(rows);
  const bps = speed(rows);
  const failedRow = rows.find((r) => r.state === 'error');

  return (
    <div className="setup">
      <div className="setup__summary">
        <span className="setup__total">
          {phase === 'ready' ? `All set — ${formatBytes(t.total)} on this Mac.` : `About ${formatBytes(t.total)} — this happens once.`}
        </span>
        {info?.freeBytes != null && <span className="mono small-meta">{formatBytes(info.freeBytes)} free on this Mac</span>}
      </div>

      {info?.smallModel && (
        <p className="setup__note" role="note">
          This Mac has {Math.round(info.totalMemBytes / 1024 ** 3)} GB of memory, so OpenKT uses the smaller understanding model. It is lighter and a little less thorough.
        </p>
      )}

      {phase === 'low-disk' && (
        <div className="card card--row setup__card setup__card--warn" role="alert">
          <span className="card__text">
            <span className="card__title">Not enough space on this Mac</span>
            <span className="card__desc">
              OpenKT needs {formatBytes(info?.neededBytes ?? t.remaining)} free to finish
              {info?.freeBytes != null ? ` and there is ${formatBytes(info.freeBytes)}` : ''}. Free up some space, then check again.
            </span>
          </span>
          <button type="button" className="btn btn--box-sm" onClick={() => void setup.retry()}>
            Check again
          </button>
        </div>
      )}

      <ul className="plain setup__list" aria-label="Models on this Mac">
        {rows.map((r) => (
          <ModelLine key={r.role} row={r} moving={moving} />
        ))}
      </ul>

      {phase !== 'ready' && phase !== 'low-disk' && (
        <div className="setup__controls">
          <span className="mono small-meta setup__progress" role="status">
            {phase === 'downloading' && [`${percent}%`, bps > 0 ? formatSpeed(bps) : 'starting…', eta !== null ? formatEta(eta) : ''].filter(Boolean).join(' · ')}
            {phase === 'paused' && `paused at ${percent}% · what arrived is kept`}
            {phase === 'error' && (failedRow ? `${ROLE_COPY[failedRow.role].name} stopped at ${pct(failedRow)}%` : plainError(setup.failure ?? undefined))}
            {phase === 'idle' && `${formatBytes(t.remaining)} still to download`}
          </span>
          {phase === 'downloading' && (
            <button type="button" className="btn btn--box-sm" onClick={() => void setup.pause()}>
              Pause
            </button>
          )}
          {phase === 'paused' && (
            <button type="button" className="btn btn--box-sm btn--dark" onClick={() => void setup.resume()}>
              Resume
            </button>
          )}
          {phase === 'error' && (
            <button type="button" className="btn btn--box-sm btn--dark" onClick={() => void setup.retry()}>
              Try again
            </button>
          )}
          {phase === 'idle' && (
            <button type="button" className="btn btn--box-sm btn--dark" onClick={() => (onStart ? onStart() : void setup.retry())}>
              Download {formatBytes(t.remaining)}
            </button>
          )}
        </div>
      )}

      <div className="setup__bundled">
        <span className="caps">Inside the app</span>
        <ul className="plain setup__inside">
          {(
            [
              ['runtime', 'The AI runtime'],
              ['transcriber', 'The transcriber'],
              ['textReader', 'The text reader'],
            ] as const
          ).map(([k, label]) => (
            <li key={k} className={info && !info.bundled[k] ? 'is-missing' : undefined}>
              {info && !info.bundled[k] ? <span className="mono">×</span> : <Icon name="check" size={13} />}
              {label}
              {info && !info.bundled[k] && <span className="mono small-meta">not in this build</span>}
            </li>
          ))}
        </ul>
        <span className="small-meta setup__inside-note">Nothing to install. Only the models above are downloaded — once, and checked before they are used.</span>
      </div>
    </div>
  );
}
