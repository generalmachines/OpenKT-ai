/**
 * Global shortcuts.
 *
 * The product's keys are: hold `fn` to talk, double-tap `fn` to latch, and a
 * screenshot key. Electron's globalShortcut cannot observe `fn` and has no
 * key-up event: `fn` needs a native event tap, which is out of scope for the
 * interim runtime (Spec 03 §1a). These are registered instead:
 *   - voice:      Control+Option+Space toggles a voice note (start · stop · save)
 *   - screenshot: Control+Option+S opens the region picker
 */
import { globalShortcut } from 'electron';
import type { HotkeyInfo } from '../shared/ipc';

export interface ShortcutActions {
  toggleVoice(): void;
  captureScreenshot(): void;
}

const FALLBACK = {
  voice: 'Control+Alt+Space',
  screenshot: 'Control+Alt+S',
} as const;

let status: HotkeyInfo[] = [];

export function registerShortcuts(actions: ShortcutActions): HotkeyInfo[] {
  const voice = globalShortcut.register(FALLBACK.voice, actions.toggleVoice);
  const shot = globalShortcut.register(FALLBACK.screenshot, actions.captureScreenshot);
  status = [
    { id: 'voice', display: 'fn', fallbackAccelerator: FALLBACK.voice, registered: voice },
    { id: 'latch', display: 'fn fn', fallbackAccelerator: null, registered: false },
    { id: 'screenshot', display: '⌃⌥S', fallbackAccelerator: FALLBACK.screenshot, registered: shot },
  ];
  return status;
}

export function shortcutStatus(): HotkeyInfo[] {
  return status;
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
