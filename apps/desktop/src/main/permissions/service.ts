/**
 * macOS privacy permissions (TCC) as one small state machine. No `electron` import: ipc.ts hands
 * in `systemPreferences`, the screen probe, `shell.openExternal` and the relaunch, so the whole
 * thing runs under plain Node with a fake in test/main/permissions.test.ts.
 *
 *   microphone     getMediaAccessStatus('microphone') · askForMediaAccess('microphone')
 *   screen         getMediaAccessStatus('screen'). macOS has no API to ask: a harmless 1×1 capture
 *                  attempt makes macOS show its prompt once and lists OpenKT in System Settings;
 *                  then the deep link. The running app only sees the new answer after a relaunch.
 *   accessibility  isTrustedAccessibilityClient(false) · (true) shows the prompt and lists OpenKT.
 *                  macOS never says "denied" here, so "asked before and still off" counts as denied.
 *   systemAudio    the Screen Recording bucket on macOS 13–14: mirrors `screen`.
 */
import { SETTINGS_URL, UNSUPPORTED_PERMISSIONS, type PermissionKind, type PermissionState, type PermissionsStatusDto } from '../../shared/permissions';

export interface SystemPreferencesLike {
  getMediaAccessStatus(mediaType: 'microphone' | 'screen'): string;
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>;
  isTrustedAccessibilityClient(prompt: boolean): boolean;
}

/** What OpenKT has already asked for. Survives the relaunch (ipc.ts keeps it in userData/permissions.json). */
export interface PermissionFlags {
  screenPrompted?: boolean;
  accessibilityPrompted?: boolean;
}

export interface PermissionsDeps {
  platform: string;
  systemPreferences: SystemPreferencesLike;
  /** `desktopCapturer.getSources({types:['screen'], thumbnailSize:{width:1,height:1}})`. Its result is thrown away. */
  probeScreen(): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  relaunch(): void | Promise<void>;
  flags: { read(): PermissionFlags; write(flags: PermissionFlags): void };
  pollMs?: number;
}

export const POLL_MS = 1500;

const STATES: readonly PermissionState[] = ['granted', 'denied', 'not-determined', 'restricted'];
const normalize = (raw: string): PermissionState => (STATES.includes(raw as PermissionState) ? (raw as PermissionState) : 'not-determined');

export class PermissionsService {
  private listeners = new Set<(s: PermissionsStatusDto) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = '';
  /** Sent to Screen Recording settings during THIS run. Not persisted: after a relaunch macOS tells the truth. */
  private sentToScreenSettings = false;

  constructor(private readonly deps: PermissionsDeps) {}

  get supported(): boolean {
    return this.deps.platform === 'darwin';
  }

  status(): PermissionsStatusDto {
    if (!this.supported) return { ...UNSUPPORTED_PERMISSIONS };
    const sp = this.deps.systemPreferences;
    const flags = this.deps.flags.read();
    const microphone = normalize(sp.getMediaAccessStatus('microphone'));
    // Electron reports "denied" for a Mac that was never asked (macOS only knows on/off here).
    const rawScreen = normalize(sp.getMediaAccessStatus('screen'));
    const screen: PermissionState = rawScreen === 'denied' && !flags.screenPrompted ? 'not-determined' : rawScreen;
    const accessibility: PermissionState = sp.isTrustedAccessibilityClient(false) ? 'granted' : flags.accessibilityPrompted ? 'denied' : 'not-determined';
    return { microphone, screen, accessibility, systemAudio: screen, relaunchSuggested: this.sentToScreenSettings && screen !== 'granted' };
  }

  /** The "Allow" button. Falls through to System Settings when macOS will not show a prompt again. */
  async request(kind: PermissionKind): Promise<PermissionsStatusDto> {
    if (!this.supported) return this.status();
    const now = this.status();
    const target: PermissionKind = kind === 'systemAudio' ? 'screen' : kind;
    if (now[target] === 'granted' || now[target] === 'restricted') return now;

    if (target === 'microphone') {
      if (now.microphone === 'not-determined') await this.deps.systemPreferences.askForMediaAccess('microphone');
      else await this.openSettings('microphone');
    } else if (target === 'screen') {
      const flags = this.deps.flags.read();
      if (flags.screenPrompted) await this.openSettings('screen');
      else {
        // First press: only the probe. macOS shows its own prompt, whose "Open System Settings" goes to the same switch.
        await this.deps.probeScreen().catch(() => undefined);
        this.deps.flags.write({ ...flags, screenPrompted: true });
        this.sentToScreenSettings = true;
      }
    } else {
      const flags = this.deps.flags.read();
      if (flags.accessibilityPrompted) await this.openSettings('accessibility');
      else {
        // Shows "OpenKT would like to control this computer using accessibility features" with its own Open System Settings button.
        this.deps.systemPreferences.isTrustedAccessibilityClient(true);
        this.deps.flags.write({ ...flags, accessibilityPrompted: true });
      }
    }
    return this.check();
  }

  /** The "Open System Settings" button. */
  async openSettings(kind: PermissionKind): Promise<void> {
    if (!this.supported) return;
    const target: PermissionKind = kind === 'systemAudio' ? 'screen' : kind;
    if (target === 'screen') {
      // The probe is what makes macOS list OpenKT under Screen Recording, so the switch is there to turn on.
      if (!this.deps.flags.read().screenPrompted) await this.deps.probeScreen().catch(() => undefined);
      this.deps.flags.write({ ...this.deps.flags.read(), screenPrompted: true });
      this.sentToScreenSettings = true;
    }
    if (target === 'accessibility') this.deps.flags.write({ ...this.deps.flags.read(), accessibilityPrompted: true });
    await this.deps.openExternal(SETTINGS_URL[target]);
    this.check();
  }

  async relaunch(): Promise<void> {
    await this.deps.relaunch();
  }

  /** Reads the state again and tells every watcher if it changed. Called by the poll and on app focus. */
  check(): PermissionsStatusDto {
    const s = this.status();
    const key = JSON.stringify(s);
    if (key !== this.last) {
      this.last = key;
      for (const l of [...this.listeners]) l(s);
    }
    return s;
  }

  /** Polls every 1.5 s while anyone is watching (the onboarding and Settings → Permissions screens). */
  watch(listener: (s: PermissionsStatusDto) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer && this.supported) {
      this.last = JSON.stringify(this.status());
      this.timer = setInterval(() => this.check(), this.deps.pollMs ?? POLL_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  get polling(): boolean {
    return this.timer !== null;
  }
}
