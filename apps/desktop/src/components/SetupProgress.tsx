import { NavLink } from 'react-router-dom';
import { useModelsSetup, type SetupPhase } from '../onboarding/models';

const LABEL: Partial<Record<SetupPhase, string>> = {
  downloading: 'Setting up on-device AI',
  idle: 'On-device AI not downloaded',
  paused: 'On-device AI paused',
  'low-disk': 'Not enough space for on-device AI',
  error: 'On-device AI download stopped',
};

/**
 * The sidebar footer while the models are still coming: one quiet line and a hairline bar,
 * linking to Settings → Models. Gone once everything is on this Mac (and in a browser).
 */
export function SetupProgress() {
  const { phase, percent } = useModelsSetup();
  const label = LABEL[phase];
  if (!label) return null;
  const attention = phase === 'error' || phase === 'low-disk';
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
