import { ModelsSetup } from '../../components/ModelsSetup';
import type { ModelsSetupState } from '../../onboarding/models';

const NOTE: Record<ModelsSetupState['phase'], string> = {
  checking: '',
  unavailable: 'You can carry on without it.',
  ready: 'Ready. Everything runs on this Mac.',
  downloading: 'Keep going — it finishes in the background, and the sidebar shows how far it is.',
  paused: 'Paused. Resume here or in Settings → Models.',
  'low-disk': 'Nothing is lost: it picks up where it stopped once there is room.',
  error: 'Nothing is lost: it picks up where it stopped.',
  idle: 'You can keep going while it downloads.',
};

/** Step 4: the download starts on its own when this screen opens (the flow's hook has autoStart on). */
export function ModelsStep({ setup, onContinue }: { setup: ModelsSetupState; onContinue: () => void }) {
  return (
    <div className="onb__main">
      <h2 className="onb__h2">Set up on-device AI</h2>
      <p className="lede onb__lede">
        OpenKT understands your voice, screenshots and notes on this Mac, so raw audio and images never leave it. The download starts on its own, and you can use OpenKT while it finishes.
      </p>
      <ModelsSetup setup={setup} />
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note" role="status">
          {NOTE[setup.phase]}
        </span>
        <button type="button" className="btn btn--accent" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
