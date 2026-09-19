import { etaSeconds, formatBytes, formatEta, formatSpeed, plainError, ROLE_COPY, rowPercent, speed, totals, type ModelRow, type ModelsSetupState } from '../onboarding/models';
import { Icon } from './Icon';

function rowState(r: ModelRow, moving: boolean): string {
  switch (r.state) {
    case 'ready':
      return 'ready';
    case 'downloading':
      return `${rowPercent(r)}% · ${formatBytes(r.receivedBytes)} of ${formatBytes(r.totalBytes)}`;
    case 'verifying':
      return 'checking the file…';
    case 'error':
      return 'stopped';
    case 'partial':
      return moving ? `waiting · ${rowPercent(r)}% here` : `${rowPercent(r)}% of ${formatBytes(r.totalBytes)}`;
    case 'missing':
      return moving ? `waiting · ${formatBytes(r.totalBytes)}` : formatBytes(r.totalBytes);
  }
}

/** "Qwen3.5-4B · Apache-2.0", the name linking to its Hugging Face model card (opens in the browser). */
function ModelFacts({ row }: { row: ModelRow }) {
  if (!row.name) return null;
  return (
    <span className="mono small-meta setup__model">
      {row.card ? (
        <a href={row.card} target="_blank" rel="noreferrer" title={row.source ? `Downloaded from ${row.source.replace('https://', '')}` : undefined}>
          {row.name}
        </a>
      ) : (
        row.name
      )}
      {row.license && ` · ${row.license}`}
    </span>
  );
}

function ModelLine({ row, moving, fresh }: { row: ModelRow; moving: boolean; fresh: boolean }) {
  const copy = ROLE_COPY[row.role];
  const failed = row.state === 'error';
  return (
    <li className={`dl setup__row setup__row--${row.state}`}>
      <span className="person__text">
        <span className="person__name">{copy.name}</span>
        <span className="person__sub" title={failed ? row.error : undefined}>
          {failed ? plainError(row.error) : copy.why}
        </span>
        <ModelFacts row={row} />
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
      {/* Before anything is chosen there is nothing to measure: no empty bars. */}
      {!fresh && (
        <span className="dl__bar" role="progressbar" aria-label={`${copy.name} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={rowPercent(row)}>
          <span style={{ width: `${rowPercent(row)}%` }} />
        </span>
      )}
    </li>
  );
}

const INSIDE = [
  ['runtime', 'The AI runtime', 'llama.cpp · MIT'],
  ['transcriber', 'The transcriber', 'whisper.cpp · MIT'],
  ['textReader', 'The text reader', 'Apple Vision, part of macOS'],
] as const;

/**
 * The on-device AI: which open-source models (job, name, licence, model card, size), the total,
 * the disk check and the smaller-model note — and once the person chooses to download, one real
 * bar per model with speed, time left, pause / resume / try again. The same on the first-run
 * screen and in Settings → Models. `offer` shows its own "Download models" card while nothing is
 * downloading (the first-run screen has the buttons in its footer instead).
 */
export function ModelsSetup({ setup, offer = true }: { setup: ModelsSetupState; offer?: boolean }) {
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
  const fresh = (phase === 'idle' || phase === 'low-disk') && t.received === 0;
  const choosing = phase === 'idle' || phase === 'low-disk';

  return (
    <div className="setup">
      {offer && choosing && (
        <div className="card card--row setup__card setup__offer">
          <span className="card__text">
            <span className="card__title">Download on-device AI</span>
            <span className="card__desc">
              {rows.length} open-source models, downloaded once. Voice, screenshots and notes are then understood on this Mac.
            </span>
          </span>
          <button type="button" className="btn btn--accent" disabled={phase === 'low-disk'} onClick={() => void setup.download()}>
            Download models ({formatBytes(t.remaining)})
          </button>
        </div>
      )}

      <p className="setup__promise">
        <Icon name="lock" size={14} />
        Everything runs on this Mac — nothing is sent to a cloud model.
      </p>

      <div className="setup__summary">
        <span className="setup__total">
          {phase === 'ready'
            ? `All set — ${formatBytes(t.total)} on this Mac.`
            : choosing
              ? t.received > 0
                ? `${formatBytes(t.remaining)} left of ${formatBytes(t.total)}, downloaded once.`
                : `${formatBytes(t.total)} in total, downloaded once.`
              : `About ${formatBytes(t.total)} — this happens once.`}
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
              OpenKT needs {formatBytes(info?.neededBytes ?? t.remaining)} free for these models
              {info?.freeBytes != null ? ` and there is ${formatBytes(info.freeBytes)}` : ''}. Free up some space, then check again.
            </span>
          </span>
          <button type="button" className="btn btn--box-sm" onClick={() => void setup.recheck()}>
            Check again
          </button>
        </div>
      )}

      <ul className="plain setup__list" aria-label="Models on this Mac">
        {rows.map((r) => (
          <ModelLine key={r.role} row={r} moving={moving} fresh={fresh} />
        ))}
      </ul>

      {!choosing && phase !== 'ready' && (
        <div className="setup__controls">
          <span className="mono small-meta setup__progress" role="status">
            {phase === 'downloading' && [`${percent}%`, bps > 0 ? formatSpeed(bps) : 'starting…', eta !== null ? formatEta(eta) : ''].filter(Boolean).join(' · ')}
            {phase === 'paused' && `paused at ${percent}% · what arrived is kept`}
            {phase === 'error' && (failedRow ? `${ROLE_COPY[failedRow.role].name} stopped at ${rowPercent(failedRow)}%` : plainError(setup.failure ?? undefined))}
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
        </div>
      )}

      <div className="setup__bundled">
        <span className="caps">Inside the app</span>
        <ul className="plain setup__inside">
          {INSIDE.map(([k, label, what]) => (
            <li key={k} className={info && !info.bundled[k] ? 'is-missing' : undefined}>
              {info && !info.bundled[k] ? <span className="mono">×</span> : <Icon name="check" size={13} />}
              {label}
              <span className="mono small-meta">{info && !info.bundled[k] ? 'not in this build' : what}</span>
            </li>
          ))}
        </ul>
        <span className="small-meta setup__inside-note">Nothing to install. Only the models above are downloaded — once, from Hugging Face, and checked before they are used.</span>
      </div>
    </div>
  );
}
