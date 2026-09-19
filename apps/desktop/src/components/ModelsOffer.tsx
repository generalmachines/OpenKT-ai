import { finishingSetup, formatBytes, totals, useModelsSetup } from '../onboarding/models';

/**
 * Where a feature needs the on-device AI and it is not on this Mac: say so in one line, and
 * offer the download right there. Nothing while it is ready — or in a browser.
 */
export function ModelsOffer({ needs }: { needs: string }) {
  const setup = useModelsSetup();
  const { phase, rows } = setup;
  if (!rows || phase === 'ready' || phase === 'checking' || phase === 'unavailable') return null;
  if (phase === 'downloading') {
    return (
      <p className="offer" role="note">
        {finishingSetup(setup.percent)}. Until then, {needs} is saved as written.
      </p>
    );
  }
  const size = formatBytes(totals(rows).remaining);
  const [label, act] =
    phase === 'paused' ? ['Resume', setup.resume] : phase === 'error' ? ['Try again', setup.retry] : [`Download (${size})`, () => setup.download()];
  return (
    <p className="offer" role="note">
      <span>
        Pulling out the key points needs the on-device AI — open-source models that run on this Mac ({size}).
        {phase === 'paused' ? ' Its download is paused.' : phase === 'low-disk' ? ' There is not enough space for it yet.' : ''}
      </span>
      <button type="button" className="btn" disabled={phase === 'low-disk'} onClick={() => void act()}>
        {label}
      </button>
    </p>
  );
}
