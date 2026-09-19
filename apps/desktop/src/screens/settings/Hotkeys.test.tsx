/** Settings › Hotkeys shows the keys this build really listens for, and why one may not work. */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HotkeyInfo } from '../../shared/ipc';
import { Hotkeys } from './Hotkeys';

function withHotkeys(list: HotkeyInfo[]) {
  (window as unknown as { openkt: unknown }).openkt = { app: { hotkeys: async () => list } };
}

afterEach(() => {
  delete (window as unknown as { openkt?: unknown }).openkt;
});

describe('Settings › Hotkeys', () => {
  it('offers the registered keys, not fn, and says when macOS keeps one', async () => {
    withHotkeys([
      { id: 'voice', display: 'fn', fallbackAccelerator: 'Control+Alt+Space', registered: true, accelerators: ['Control+Alt+Space', 'Control+Alt+N'], problem: 'macOS uses ⌃⌥Space to switch input sources, so it may never reach OpenKT. Press ⌃⌥N instead.' },
      { id: 'latch', display: 'fn fn', fallbackAccelerator: null, registered: false, accelerators: [], problem: null },
      { id: 'screenshot', display: '⌃⌥S', fallbackAccelerator: 'Control+Alt+S', registered: false, accelerators: [], problem: '⌃⌥S is held by another app.' },
    ]);
    render(<Hotkeys />);
    expect(await screen.findByText(/macOS uses ⌃⌥Space to switch input sources/)).toBeInTheDocument();
    expect(screen.getByText('⌃⌥S is held by another app.')).toBeInTheDocument();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('N')).toBeInTheDocument();
    expect(screen.queryByText('Hold to talk')).not.toBeInTheDocument();
  });

  it('outside the desktop app it shows the default keys and says where they work', () => {
    render(<Hotkeys />);
    expect(screen.getByText(/press again to stop and save · in OpenKT for Mac/)).toBeInTheDocument();
  });
});
