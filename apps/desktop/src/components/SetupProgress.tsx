import { NavLink } from 'react-router-dom';
import { formatBytes, totals, useModelsSetup, type SetupPhase } from '../onboarding/models';

const LABEL: Partial<Record<SetupPhase, string>> = {
  downloading: 'Setting up on-device AI',
  idle: 'Download on-device AI',
  paused: 'On-device AI paused',
  'low-disk': 'Not enough space for on-device AI',
  error: 'On-device AI download stopped',
};

/**
 * The sidebar footer until the on-device AI is on this Mac: while it downloads, how far; before
 * the person chose to (Later), a quiet "Download on-device AI" entry with its size. Both link to
 * Settings → Models. Gone once everything is on this Mac (and in a browser).
 */
export function SetupProgress() {
  const { phase, percent, rows } = useModelsSetup();
  const label = LABEL[phase];
  if (!label) return null;
  const attention = phase === 'error' || phase === 'low-disk';
  const untouched = phase === 'idle' && rows && totals(rows).received === 0;
  if (untouched) {
    return (
      <NavLink to="/settings/models" className="sidesetup" aria-label={`${label}, ${formatBytes(totals(rows).total)}`}>
        <span className="sidesetup__top">
          <span className="sidesetup__label">{label}</span>
          <span className="mono sidesetup__pct">{formatBytes(totals(rows).total)}</span>
        </span>
      </NavLink>
    );
  }
  return (
    <NavLink to="/settings/models" className={`sidesetup${attention ? ' sidesetup--attention' : ''}`} aria-label={`${label}, ${percent}%`}>
      <span className="sidesetup__top">
        <span className="sidesetup__label">{label}</span>
        <span className="mono sidesetup__pct">{percent}%</span>
      </span>
      <span className="sidesetup__bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </NavLink>
  );
}
