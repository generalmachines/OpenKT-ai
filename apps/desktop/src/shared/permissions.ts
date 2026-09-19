/**
 * System permissions: the types both sides share and the ONE pure rule that turns a
 * permission's state into the button the person sees. No `electron`, no DOM — the main
 * process (src/main/permissions), the renderer (src/components/PermissionsList.tsx) and
 * the tests all import this.
 */

export type PermissionKind = 'microphone' | 'screen' | 'accessibility' | 'systemAudio';
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unsupported';

export const PERMISSION_KINDS: readonly PermissionKind[] = ['microphone', 'screen', 'accessibility', 'systemAudio'];

export interface PermissionsStatusDto {
  microphone: PermissionState;
  screen: PermissionState;
  accessibility: PermissionState;
  /** macOS 13–14 keep system audio in the Screen Recording bucket, so this mirrors `screen`. */
  systemAudio: PermissionState;
  /**
   * True once OpenKT has sent the person to System Settings for Screen Recording and macOS still
   * reports it as off for this run: macOS only hands a running app the new answer after it is reopened.
   */
  relaunchSuggested: boolean;
}

export const UNSUPPORTED_PERMISSIONS: PermissionsStatusDto = {
  microphone: 'unsupported',
  screen: 'unsupported',
  accessibility: 'unsupported',
  systemAudio: 'unsupported',
  relaunchSuggested: false,
};

/** What the row's single button does. `none` rows show a label instead of a button. */
export type PermissionAction =
  | { type: 'request'; label: 'Allow' }
  | { type: 'open-settings'; label: 'Open System Settings' }
  | { type: 'none'; label: string };

/**
 * One button per row, and it always does the right thing for the state:
 *   not-determined → Allow (the macOS prompt) · denied → Open System Settings (the prompt never comes back)
 *   granted → nothing to do · restricted → nothing the person can do · unsupported → not a Mac.
 * System audio has no switch of its own: it follows Screen Recording.
 */
export function actionFor(kind: PermissionKind, state: PermissionState): PermissionAction {
  if (kind === 'systemAudio') return { type: 'none', label: state === 'unsupported' ? 'Not needed on this computer' : 'Included with Screen Recording' };
  switch (state) {
    case 'granted':
      return { type: 'none', label: 'Granted' };
    case 'not-determined':
      return { type: 'request', label: 'Allow' };
    case 'denied':
      return { type: 'open-settings', label: 'Open System Settings' };
    case 'restricted':
      return { type: 'none', label: 'Managed by this Mac’s administrator' };
    case 'unsupported':
      return { type: 'none', label: 'Not needed on this computer' };
  }
}

/** The words in the status pill. */
export function stateLabel(state: PermissionState): string {
  switch (state) {
    case 'granted':
      return 'Allowed';
    case 'denied':
      return 'Off';
    case 'not-determined':
      return 'Not asked yet';
    case 'restricted':
      return 'Restricted';
    case 'unsupported':
      return 'Not needed';
  }
}

/** Onboarding may continue once the microphone question has an answer — any answer. */
export function microphoneDecided(status: Pick<PermissionsStatusDto, 'microphone'>): boolean {
  return status.microphone !== 'not-determined';
}

/** Nothing here applies (Windows, Linux, a browser): onboarding skips the step and says so. */
export function permissionsUnsupported(status: PermissionsStatusDto): boolean {
  return status.microphone === 'unsupported' && status.screen === 'unsupported' && status.accessibility === 'unsupported';
}

/** The permissions still worth a reminder chip in Settings. System audio never counts: it has no switch. */
export function permissionsOutstanding(status: PermissionsStatusDto): PermissionKind[] {
  return (['microphone', 'screen', 'accessibility'] as const).filter((k) => status[k] === 'denied' || status[k] === 'not-determined');
}

/** `x-apple.systempreferences:` deep links into Privacy & Security. */
export const SETTINGS_URL: Record<PermissionKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

export function isPermissionKind(v: unknown): v is PermissionKind {
  return typeof v === 'string' && (PERMISSION_KINDS as readonly string[]).includes(v);
}
