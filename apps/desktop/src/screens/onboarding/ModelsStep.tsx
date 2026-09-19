import { ModelsSetup } from '../../components/ModelsSetup';
import { formatBytes, totals, type ModelsSetupState } from '../../onboarding/models';

const NOTE: Record<ModelsSetupState['phase'], string> = {
  checking: '',
  unavailable: 'You can carry on without it.',
  ready: 'Ready. Everything runs on this Mac.',
  downloading: 'Keep going — it finishes in the background, and the sidebar shows how far it is.',
  paused: 'Paused. Resume here or in Settings → Models.',
  'low-disk': 'Or later — Settings → Models keeps it one click away.',
  error: 'Nothing is lost: it picks up where it stopped.',
  idle: 'Or later — Settings → Models keeps it one click away.',
};

/**
 * Step 4: an informed choice, never a silent download. The open-source models with their job,
 * licence, model card and size; the total; then "Download models" or "Later". After Download it
 * is the same progress as Settings → Models (pause, resume, try again, the sidebar indicator).
 */
export function ModelsStep({ setup, onContinue, onLater }: { setup: ModelsSetupState; onContinue: () => void; onLater: () => void }) {
  const choosing = setup.phase === 'idle' || setup.phase === 'low-disk';
  const remaining = setup.rows ? totals(setup.rows).remaining : 0;
  return (
    <div className="onb__main">
      <h2 className="onb__h2">Set up on-device AI</h2>
      <p className="lede onb__lede">
        OpenKT understands your voice, screenshots and notes with open-source models that run on this Mac. Download them now, or later — nothing is fetched until you choose.
      </p>
      <ModelsSetup setup={setup} offer={false} />
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note" role="status">
          {NOTE[setup.phase]}
        </span>
        {choosing ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={onLater}>
              Later
            </button>
            <button type="button" className="btn btn--accent" disabled={setup.phase === 'low-disk'} onClick={() => void setup.download()}>
              Download models ({formatBytes(remaining)})
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--accent" disabled={setup.phase === 'checking'} onClick={onContinue}>
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
