import { useEffect, useState } from 'react';
import { displayOf } from '../shared/hotkeys';
import type { HotkeyInfo } from '../shared/ipc';

/** What main registered (null outside the desktop app, or before it answers). */
export function useHotkeys(): HotkeyInfo[] | null {
  const [info, setInfo] = useState<HotkeyInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    void window.openkt?.app
      ?.hotkeys?.()
      .then((h) => live && setInfo(h))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** The keys that start a voice note in this build, as shown to a person ("⌃⌥Space"), or null when none is registered. */
export function voiceKeys(info: HotkeyInfo[] | null): string[] | null {
  const voice = info?.find((h) => h.id === 'voice');
  if (!voice) return null;
  const keys = voice.accelerators?.length ? voice.accelerators : voice.registered && voice.fallbackAccelerator ? [voice.fallbackAccelerator] : [];
  return keys.length ? keys.map(displayOf) : null;
}
