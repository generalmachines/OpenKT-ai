/**
 * Global shortcuts.
 *
 * The product's keys are: hold `fn` to talk, double-tap `fn` to latch, and a
 * screenshot key. Electron's globalShortcut cannot observe `fn` and has no
 * key-up event: `fn` needs a native event tap, which is out of scope for the
 * interim runtime (Spec 03 §1a). These are registered instead:
 *   - voice:      Control+Option+Space, and Control+Option+N, toggle a voice note (start · stop · save)
 *   - screenshot: Control+Option+S opens the region picker
 *
 * Nothing here fails silently. A key another app holds, a key macOS keeps for itself
 * (⌃⌥Space switches input sources unless that is turned off), and a capture that cannot
 * start (the microphone or screen recording turned off) are all reported: in
 * Settings › Hotkeys through `shortcutStatus()`, and as a notification when the key is pressed.
 */
import { execFile } from 'node:child_process';
import { Notification, globalShortcut, systemPreferences } from 'electron';
import { displayOf } from '../shared/hotkeys';
import type { HotkeyInfo } from '../shared/ipc';

export interface ShortcutActions {
  toggleVoice(): void | Promise<void>;
  captureScreenshot(): void | Promise<void>;
}

/** Tried in order; every one that registers works. The second voice key is there because macOS often keeps the first. */
export const KEYS = {
  voice: ['Control+Alt+Space', 'Control+Alt+N'],
  screenshot: ['Control+Alt+S'],
} as const;

export { displayOf };

export const INPUT_SOURCE_PROBLEM =
  'macOS uses ⌃⌥Space to switch input sources, so it may never reach OpenKT. Press ⌃⌥N instead, or turn off “Select next source in Input menu” in System Settings › Keyboard › Keyboard Shortcuts › Input Sources.';

/**
 * Whether macOS's "Select next source in Input menu" (symbolic hot key 61, ⌃⌥Space) is on.
 * `defaults` lists only what was changed; absent means the default, which is on.
 */
export function inputSourceKeyOn(plist: string | null): boolean {
  if (plist === null) return true;
  const m = /\b61\s*=\s*\{[^}]*?enabled\s*=\s*(\d)/s.exec(plist);
  return m ? m[1] === '1' : true;
}

export interface ShortcutDeps {
  platform: string;
  register(accelerator: string, fn: () => void): boolean;
  /** `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys`, or null when it cannot be read. */
  readSymbolicHotkeys(): Promise<string | null>;
}

const electronDeps: ShortcutDeps = {
  platform: process.platform,
  register: (accelerator, fn) => {
    try {
      return globalShortcut.register(accelerator, fn);
    } catch {
      return false;
    }
  },
  readSymbolicHotkeys: () =>
    new Promise((resolve) => execFile('defaults', ['read', 'com.apple.symbolichotkeys', 'AppleSymbolicHotKeys'], { timeout: 3000 }, (err, out) => resolve(err ? null : String(out)))),
};

let status: HotkeyInfo[] = [];

function row(id: 'voice' | 'screenshot', accelerators: readonly string[], registered: string[], fn: string): HotkeyInfo {
  const taken = accelerators.filter((a) => !registered.includes(a));
  return {
    id,
    display: fn,
    fallbackAccelerator: registered[0] ?? accelerators[0] ?? null,
    registered: registered.length > 0,
    accelerators: registered,
    problem: registered.length === 0 ? `${accelerators.map(displayOf).join(' and ')} ${accelerators.length === 1 ? 'is' : 'are'} held by another app.` : taken.length ? `${taken.map(displayOf).join(', ')} is held by another app; ${registered.map(displayOf).join(', ')} works.` : null,
  };
}

export function registerShortcuts(actions: ShortcutActions, deps: ShortcutDeps = electronDeps): HotkeyInfo[] {
  const voice = KEYS.voice.filter((a) => deps.register(a, () => void actions.toggleVoice()));
  const shot = KEYS.screenshot.filter((a) => deps.register(a, () => void actions.captureScreenshot()));
  status = [row('voice', KEYS.voice, voice, 'fn'), { id: 'latch', display: 'fn fn', fallbackAccelerator: null, registered: false, accelerators: [], problem: null }, row('screenshot', KEYS.screenshot, shot, displayOf(KEYS.screenshot[0]))];
  if (voice.length === 0 || shot.length === 0) console.warn('[shortcuts] not registered:', status.filter((s) => s.problem).map((s) => `${s.id}: ${s.problem}`).join(' | '));
  return status;
}

/** macOS only: flag ⌃⌥Space when the system keeps it. Resolves with the updated status. */
export async function checkSystemConflicts(deps: ShortcutDeps = electronDeps): Promise<HotkeyInfo[]> {
  if (deps.platform !== 'darwin') return status;
  const voice = status.find((s) => s.id === 'voice');
  if (!voice?.accelerators?.includes(KEYS.voice[0]) || !inputSourceKeyOn(await deps.readSymbolicHotkeys())) return status;
  status = status.map((s) => (s.id === 'voice' ? { ...s, problem: INPUT_SOURCE_PROBLEM } : s));
  return status;
}

export function shortcutStatus(): HotkeyInfo[] {
  return status;
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}

// ── when a key is pressed but the capture cannot start ────────────────────────

export interface CaptureGuardDeps {
  platform: string;
  mediaAccess(kind: 'microphone' | 'screen'): string;
  notify(title: string, body: string): void;
  openSettings(route: string): void;
}

const guardDeps: CaptureGuardDeps = {
  platform: process.platform,
  mediaAccess: (kind) => {
    try {
      return systemPreferences.getMediaAccessStatus(kind);
    } catch {
      return 'unknown';
    }
  },
  notify: (title, body) => {
    console.warn(`[shortcuts] ${title} — ${body}`);
    if (Notification.isSupported()) new Notification({ title, body }).show();
  },
  openSettings: () => undefined,
};

const OFF = new Set(['denied', 'restricted']);

/**
 * Wraps a capture action for a key press: says why when it cannot start (permission off, or it threw)
 * instead of doing nothing. `openSettings` shows the page that fixes it.
 */
export function guardCapture(kind: 'voice' | 'screenshot', run: () => Promise<void>, deps: Partial<CaptureGuardDeps> = {}): () => Promise<void> {
  const d = { ...guardDeps, ...deps };
  return async () => {
    if (d.platform === 'darwin') {
      const need = kind === 'voice' ? 'microphone' : 'screen';
      if (OFF.has(d.mediaAccess(need))) {
        d.notify(
          kind === 'voice' ? 'Voice notes need the microphone' : 'Screenshots need screen recording',
          `OpenKT is not allowed to use the ${kind === 'voice' ? 'microphone' : 'screen'}. Turn it on in System Settings › Privacy & Security › ${kind === 'voice' ? 'Microphone' : 'Screen & System Audio Recording'}.`,
        );
        d.openSettings('/settings/permissions');
        return;
      }
    }
    try {
      await run();
    } catch (e) {
      d.notify(kind === 'voice' ? 'Could not start a voice note' : 'Could not take a screenshot', e instanceof Error ? e.message : String(e));
    }
  };
}
