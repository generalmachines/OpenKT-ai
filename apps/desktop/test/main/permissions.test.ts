/**
 * The macOS permission state machine (src/main/permissions/service.ts) against a FAKE
 * `systemPreferences`: every state → the right button, and the right thing happens when it
 * is pressed. No Electron and no Mac: TCC prompts, System Settings and the relaunch itself
 * are exactly what these fakes stand in for (see docs/manual-test-permissions.md for those).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsService, type PermissionFlags, type SystemPreferencesLike } from '../../src/main/permissions/service';
import {
  actionFor,
  microphoneDecided,
  permissionsOutstanding,
  permissionsUnsupported,
  SETTINGS_URL,
  stateLabel,
  type PermissionKind,
  type PermissionState,
} from '../../src/shared/permissions';

interface FakeMac {
  mic: string;
  screen: string;
  trusted: boolean;
  /** What the microphone prompt answers. */
  answer: boolean;
}

function setup(mac: Partial<FakeMac> = {}, platform = 'darwin', stored: PermissionFlags = {}) {
  const state: FakeMac = { mic: 'not-determined', screen: 'denied', trusted: false, answer: true, ...mac };
  let flags: PermissionFlags = { ...stored };
  const sp: SystemPreferencesLike & { [k: string]: ReturnType<typeof vi.fn> } = {
    getMediaAccessStatus: vi.fn((t: 'microphone' | 'screen') => (t === 'microphone' ? state.mic : state.screen)),
    askForMediaAccess: vi.fn(async () => {
      state.mic = state.answer ? 'granted' : 'denied';
      return state.answer;
    }),
    isTrustedAccessibilityClient: vi.fn(() => state.trusted),
  };
  const deps = {
    platform,
    systemPreferences: sp,
    probeScreen: vi.fn(async () => []),
    openExternal: vi.fn(async () => undefined),
    relaunch: vi.fn(),
    flags: { read: () => ({ ...flags }), write: (f: PermissionFlags) => void (flags = { ...f }) },
    pollMs: 1500,
  };
  const svc = new PermissionsService(deps);
  return { svc, sp, deps, state, flags: () => flags };
}

afterEach(() => vi.useRealTimers());

describe('the one button per row', () => {
  const table: [PermissionKind, PermissionState, string, string][] = [
    ['microphone', 'not-determined', 'request', 'Allow'],
    ['microphone', 'denied', 'open-settings', 'Open System Settings'],
    ['microphone', 'granted', 'none', 'Granted'],
    ['microphone', 'restricted', 'none', 'Managed by this Mac’s administrator'],
    ['microphone', 'unsupported', 'none', 'Not needed on this computer'],
    ['screen', 'not-determined', 'request', 'Allow'],
    ['screen', 'denied', 'open-settings', 'Open System Settings'],
    ['screen', 'granted', 'none', 'Granted'],
    ['accessibility', 'not-determined', 'request', 'Allow'],
    ['accessibility', 'denied', 'open-settings', 'Open System Settings'],
    ['accessibility', 'granted', 'none', 'Granted'],
    ['systemAudio', 'granted', 'none', 'Included with Screen Recording'],
    ['systemAudio', 'denied', 'none', 'Included with Screen Recording'],
    ['systemAudio', 'unsupported', 'none', 'Not needed on this computer'],
  ];
  it.each(table)('%s %s → %s “%s”', (kind, state, type, label) => {
    expect(actionFor(kind, state)).toEqual({ type, label });
  });

  it('labels every state in plain words, and only the microphone gates Continue', () => {
    expect(['granted', 'denied', 'not-determined', 'restricted', 'unsupported'].map((s) => stateLabel(s as PermissionState))).toEqual(['Allowed', 'Off', 'Not asked yet', 'Restricted', 'Not needed']);
    expect(microphoneDecided({ microphone: 'not-determined' })).toBe(false);
    expect(microphoneDecided({ microphone: 'denied' })).toBe(true);
    expect(microphoneDecided({ microphone: 'granted' })).toBe(true);
  });

  it('deep links go to the right Privacy & Security pane', () => {
    expect(SETTINGS_URL.microphone).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    expect(SETTINGS_URL.screen).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    expect(SETTINGS_URL.accessibility).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
});

describe('PermissionsService.status', () => {
  it('reads a Mac that was never asked as not-determined everywhere (Electron says "denied" for screen)', () => {
    const { svc } = setup();
    expect(svc.status()).toEqual({ microphone: 'not-determined', screen: 'not-determined', accessibility: 'not-determined', systemAudio: 'not-determined', relaunchSuggested: false });
  });

  it('system audio follows Screen Recording; every state passes through', () => {
    for (const s of ['granted', 'denied', 'restricted'] as const) {
      const { svc } = setup({ mic: s, screen: s }, 'darwin', { screenPrompted: true, accessibilityPrompted: true });
      const st = svc.status();
      expect(st.microphone).toBe(s);
      expect(st.screen).toBe(s);
      expect(st.systemAudio).toBe(s);
    }
    expect(setup({ mic: 'something-new' }).svc.status().microphone).toBe('not-determined');
  });

  it('not a Mac: every permission is unsupported and onboarding skips the step', async () => {
    const { svc, sp, deps } = setup({}, 'win32');
    const st = svc.status();
    expect(permissionsUnsupported(st)).toBe(true);
    expect(permissionsOutstanding(st)).toEqual([]);
    await svc.request('microphone');
    await svc.openSettings('screen');
    expect(sp.askForMediaAccess).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});

describe('PermissionsService.request — the right thing for each state', () => {
  it('microphone, never asked → the macOS prompt; the answer is read back', async () => {
    const { svc, sp, deps } = setup({ answer: true });
    const st = await svc.request('microphone');
    expect(sp.askForMediaAccess).toHaveBeenCalledWith('microphone');
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(st.microphone).toBe('granted');
  });

  it('microphone, refused → a "no" still counts as decided', async () => {
    const { svc } = setup({ answer: false });
    const st = await svc.request('microphone');
    expect(st.microphone).toBe('denied');
    expect(microphoneDecided(st)).toBe(true);
  });

  it('microphone, denied before → System Settings, because macOS will not ask again', async () => {
    const { svc, sp, deps } = setup({ mic: 'denied' });
    await svc.request('microphone');
    expect(sp.askForMediaAccess).not.toHaveBeenCalled();
    expect(deps.openExternal).toHaveBeenCalledWith(SETTINGS_URL.microphone);
  });

  it('granted and restricted do nothing at all', async () => {
    const { svc, sp, deps } = setup({ mic: 'granted', screen: 'restricted' }, 'darwin', { screenPrompted: true });
    await svc.request('microphone');
    await svc.request('screen');
    expect(sp.askForMediaAccess).not.toHaveBeenCalled();
    expect(deps.probeScreen).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('screen recording: Allow = one harmless 1×1 capture (the macOS prompt); the next press deep-links; then Relaunch is offered', async () => {
    const { svc, deps, flags } = setup();
    const first = await svc.request('screen');
    expect(deps.probeScreen).toHaveBeenCalledTimes(1);
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(flags().screenPrompted).toBe(true);
    // macOS keeps reporting "denied" to this process, and now that it has asked that is the truth
    expect(first.screen).toBe('denied');
    expect(actionFor('screen', first.screen).type).toBe('open-settings');
    expect(first.relaunchSuggested).toBe(true);

    await svc.request('screen');
    expect(deps.probeScreen).toHaveBeenCalledTimes(1);
    expect(deps.openExternal).toHaveBeenCalledWith(SETTINGS_URL.screen);
  });

  it('screen recording: "Open System Settings" before any prompt still probes first, so OpenKT is listed there', async () => {
    const { svc, deps } = setup();
    await svc.openSettings('screen');
    expect(deps.probeScreen).toHaveBeenCalledTimes(1);
    expect(deps.openExternal).toHaveBeenCalledWith(SETTINGS_URL.screen);
    expect(svc.status().relaunchSuggested).toBe(true);
  });

  it('system audio has no switch of its own: requesting it goes to Screen Recording', async () => {
    const { svc, deps } = setup({}, 'darwin', { screenPrompted: true });
    await svc.request('systemAudio');
    expect(deps.openExternal).toHaveBeenCalledWith(SETTINGS_URL.screen);
  });

  it('relaunch is no longer suggested once Screen Recording reads granted (after the reopen)', async () => {
    const { svc, state } = setup();
    await svc.request('screen');
    expect(svc.status().relaunchSuggested).toBe(true);
    state.screen = 'granted';
    expect(svc.status().relaunchSuggested).toBe(false);
  });

  it('after a relaunch the new process tells the truth: the flag is not carried over', () => {
    // what ipc.ts persists is only whether macOS was asked; "sent to settings" is per run
    const { svc } = setup({ screen: 'denied' }, 'darwin', { screenPrompted: true });
    expect(svc.status()).toMatchObject({ screen: 'denied', relaunchSuggested: false });
  });

  it('accessibility: first press shows the macOS prompt (isTrusted(true)); after that it reads denied and deep-links', async () => {
    const { svc, sp, deps, flags } = setup();
    const st = await svc.request('accessibility');
    expect(sp.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    expect(flags().accessibilityPrompted).toBe(true);
    expect(st.accessibility).toBe('denied');
    expect(deps.openExternal).not.toHaveBeenCalled();
    await svc.request('accessibility');
    expect(deps.openExternal).toHaveBeenCalledWith(SETTINGS_URL.accessibility);
  });

  it('accessibility granted in System Settings reads granted without a relaunch', async () => {
    const { svc, state } = setup({}, 'darwin', { accessibilityPrompted: true });
    expect(svc.status().accessibility).toBe('denied');
    state.trusted = true;
    expect(svc.status().accessibility).toBe('granted');
  });

  it('relaunch hands over to the injected relaunch (ipc.ts: flush storage, app.relaunch, app.exit)', async () => {
    const { svc, deps } = setup();
    await svc.relaunch();
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe('PermissionsService.watch — live status while a screen is open', () => {
  it('polls every 1.5 s while watched, tells watchers only about changes, and stops when the last one leaves', () => {
    vi.useFakeTimers();
    const { svc, state } = setup();
    const seen: string[] = [];
    const off = svc.watch((s) => seen.push(s.microphone));
    expect(svc.polling).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(seen).toEqual([]); // nothing changed
    state.mic = 'granted';
    vi.advanceTimersByTime(1499);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['granted']);
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual(['granted']);
    off();
    expect(svc.polling).toBe(false);
  });

  it('check() (what app focus calls) pushes a change straight away', () => {
    const { svc, state } = setup();
    const seen: string[] = [];
    const off = svc.watch((s) => seen.push(s.accessibility));
    state.trusted = true;
    svc.check();
    expect(seen).toEqual(['granted']);
    off();
  });

  it('does not poll on a computer that has no permissions', () => {
    const { svc } = setup({}, 'linux');
    const off = svc.watch(() => undefined);
    expect(svc.polling).toBe(false);
    off();
  });
});
