import { useCallback, useEffect, useState } from 'react';
import { permissions as permissionsBridge } from '../api/setup-bridge';
import { actionFor, stateLabel, type PermissionKind, type PermissionsStatusDto } from '../shared/permissions';
import { Icon, type IconName } from './Icon';

/** Live permission state: read once, then pushed from main while this is mounted (1.5 s poll + focus). */
export function usePermissions() {
  const [status, setStatus] = useState<PermissionsStatusDto | null>(null);
  const [busy, setBusy] = useState<PermissionKind | null>(null);
  useEffect(() => {
    let live = true;
    void permissionsBridge.status().then((s) => live && setStatus(s));
    const off = permissionsBridge.onChange((s) => live && setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  const request = useCallback(async (kind: PermissionKind) => {
    setBusy(kind);
    try {
      setStatus(await permissionsBridge.request(kind));
    } finally {
      setBusy(null);
    }
  }, []);
  const openSettings = useCallback(async (kind: PermissionKind) => {
    await permissionsBridge.openSettings(kind);
    setStatus(await permissionsBridge.status());
  }, []);
  const relaunch = useCallback(() => permissionsBridge.relaunch(), []);
  return { status, busy, request, openSettings, relaunch };
}

interface RowSpec {
  kind: PermissionKind;
  icon: IconName;
  name: string;
  why: string;
}

/** The three switches a Mac has, in the app's words. Meetings ride on Screen Recording and are not shipped yet. */
export const PERMISSION_ROWS: readonly RowSpec[] = [
  { kind: 'microphone', icon: 'mic', name: 'Microphone', why: 'to turn what you say into notes' },
  { kind: 'screen', icon: 'shot', name: 'Screen Recording', why: 'to save what you’re looking at, and meetings later' },
  { kind: 'accessibility', icon: 'cursor', name: 'Accessibility', why: 'so the shortcut works everywhere' },
];

export function PermissionRow({
  spec,
  status,
  busy,
  onRequest,
  onOpenSettings,
}: {
  spec: RowSpec;
  status: PermissionsStatusDto;
  busy: PermissionKind | null;
  onRequest: (kind: PermissionKind) => void;
  onOpenSettings: (kind: PermissionKind) => void;
}) {
  const state = status[spec.kind];
  const action = actionFor(spec.kind, state);
  return (
    <li className={`perm perm--${state}`}>
      <span className="perm__icon" aria-hidden="true">
        <Icon name={spec.icon} size={18} />
      </span>
      <span className="person__text">
        <span className="person__name">{spec.name}</span>
        <span className="person__sub">{spec.why}</span>
      </span>
      <span className={`perm__pill mono perm__pill--${state}`} role="status" aria-label={`${spec.name}: ${stateLabel(state)}`}>
        <span className="perm__dot" aria-hidden="true" />
        {stateLabel(state)}
      </span>
      {action.type === 'none' ? (
        <span className="perm__done mono">
          {state === 'granted' && <Icon name="check" size={13} stroke={2} />}
          {action.label}
        </span>
      ) : (
        <button
          type="button"
          className={`btn btn--box-sm${action.type === 'request' ? ' btn--dark' : ''}`}
          disabled={busy !== null}
          aria-label={`${action.label}: ${spec.name}`}
          onClick={() => (action.type === 'request' ? onRequest(spec.kind) : onOpenSettings(spec.kind))}
        >
          {busy === spec.kind ? 'Asking…' : action.label}
        </button>
      )}
    </li>
  );
}

/** "How this works on a Mac" and the privacy line, under the rows on both screens. */
export function PermissionsHelp() {
  return (
    <div className="perms__help">
      <span className="caps">How this works on a Mac</span>
      <ol className="perms__how">
        <li>Allow opens the Mac’s own question. Answer it there.</li>
        <li>If you said no before, the Mac won’t ask again — the button opens System Settings at the right switch instead.</li>
        <li>After you turn on Screen Recording, the Mac asks OpenKT to quit and reopen. Use the button that appears here — you’ll land back on this screen.</li>
      </ol>
      <p className="perms__privacy">
        <Icon name="lock" size={14} />
        Audio and screenshots are processed on this Mac. The recordings and images stay here — only the notes made from them are saved to your account.
      </p>
    </div>
  );
}

/**
 * The same rows on the first-run screen and in Settings → Permissions. Each row has ONE button
 * that does the right thing for its state; the list itself never decides what "enough" is.
 */
export function PermissionsList({
  status,
  busy,
  onRequest,
  onOpenSettings,
  onRelaunch,
}: {
  status: PermissionsStatusDto;
  busy: PermissionKind | null;
  onRequest: (kind: PermissionKind) => void;
  onOpenSettings: (kind: PermissionKind) => void;
  onRelaunch: () => void;
}) {
  const audio = actionFor('systemAudio', status.systemAudio);
  return (
    <ul className="plain perms" aria-label="Permissions">
      {PERMISSION_ROWS.map((spec) => (
        <PermissionRow key={spec.kind} spec={spec} status={status} busy={busy} onRequest={onRequest} onOpenSettings={onOpenSettings} />
      ))}
      <li className="perm perm--audio">
        <span className="perm__icon" aria-hidden="true">
          <Icon name="video" size={18} />
        </span>
        <span className="person__text">
          <span className="person__name">
            Meetings <span className="perm__soon mono">coming soon</span>
          </span>
          <span className="person__sub">to record a call you choose to keep — not in this version yet</span>
        </span>
        <span className="perm__done mono">{audio.label}</span>
      </li>
      {status.relaunchSuggested && (
        <li className="perm__relaunch" role="status">
          <span className="person__text">
            <span className="person__name">Turned on Screen Recording?</span>
            <span className="person__sub">macOS only tells OpenKT after it reopens. You’ll come straight back here.</span>
          </span>
          <button type="button" className="btn btn--box-sm btn--dark" onClick={onRelaunch}>
            Relaunch OpenKT
          </button>
        </li>
      )}
    </ul>
  );
}
