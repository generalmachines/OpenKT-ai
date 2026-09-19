import { useEffect } from 'react';
import { PermissionsHelp, PermissionsList, usePermissions } from '../../components/PermissionsList';
import { microphoneDecided, permissionsOutstanding, permissionsUnsupported } from '../../shared/permissions';

/**
 * Step 2: the three switches a Mac has, each with one button that does the right thing.
 * A computer that has none of them (not a Mac) moves straight on — the rail says why.
 */
export function PermissionsStep({ onContinue, onNothingToAllow }: { onContinue: () => void; onNothingToAllow: () => void }) {
  const { status, busy, request, openSettings, relaunch } = usePermissions();
  const unsupported = status !== null && permissionsUnsupported(status);

  useEffect(() => {
    if (unsupported) onNothingToAllow();
  }, [unsupported, onNothingToAllow]);

  const decided = status ? microphoneDecided(status) : false;
  const waiting = status ? permissionsOutstanding(status).filter((k) => k !== 'microphone') : [];
  const note = !status
    ? 'Checking this Mac…'
    : !decided
      ? 'Answer the microphone question to continue — yes or no, either is fine.'
      : waiting.length > 0
        ? 'The rest can wait. Settings → Permissions keeps a reminder.'
        : 'All set. You can change any of these in Settings.';

  return (
    <div className="onb__main">
      <h2 className="onb__h2">Allow access</h2>
      <p className="lede onb__lede">OpenKT listens and looks only when you press the shortcut. Your Mac asks you about each of these once.</p>
      {status ? (
        <PermissionsList status={status} busy={busy} onRequest={(k) => void request(k)} onOpenSettings={(k) => void openSettings(k)} onRelaunch={() => void relaunch()} />
      ) : (
        <p className="state mono">checking this Mac…</p>
      )}
      <PermissionsHelp />
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note" role="status">
          {note}
        </span>
        <button type="button" className="btn btn--accent" disabled={!decided} onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
