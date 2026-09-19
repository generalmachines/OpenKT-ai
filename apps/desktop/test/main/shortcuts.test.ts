/**
 * Global shortcuts never fail silently (src/main/shortcuts.ts): a key another app holds, the
 * ⌃⌥Space that macOS keeps for switching input sources, and a capture that cannot start
 * (microphone or screen recording off) are each reported. Fakes stand in for Electron and the Mac.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  globalShortcut: { register: vi.fn(() => true), unregisterAll: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted') },
}));

const { KEYS, INPUT_SOURCE_PROBLEM, checkSystemConflicts, guardCapture, inputSourceKeyOn, registerShortcuts } = await import('../../src/main/shortcuts');

const actions = { toggleVoice: vi.fn(), captureScreenshot: vi.fn() };
const deps = (taken: string[] = [], plist: string | null = null, platform = 'darwin') => ({
  platform,
  register: vi.fn((a: string) => !taken.includes(a)),
  readSymbolicHotkeys: vi.fn(async () => plist),
});

describe('registering', () => {
  it('registers both voice keys and the screenshot key, with no problem to report', () => {
    const d = deps();
    const status = registerShortcuts(actions, d);
    expect(d.register.mock.calls.map((c) => c[0])).toEqual([...KEYS.voice, ...KEYS.screenshot]);
    expect(status.find((s) => s.id === 'voice')).toMatchObject({ registered: true, accelerators: ['Control+Alt+Space', 'Control+Alt+N'], problem: null });
    expect(status.find((s) => s.id === 'screenshot')).toMatchObject({ registered: true, accelerators: ['Control+Alt+S'], problem: null });
  });

  it('a key another app holds is named, and the one that works is too', () => {
    const status = registerShortcuts(actions, deps(['Control+Alt+Space']));
    expect(status.find((s) => s.id === 'voice')).toMatchObject({ registered: true, accelerators: ['Control+Alt+N'], problem: '⌃⌥Space is held by another app; ⌃⌥N works.' });
  });

  it('nothing registered is said as such, not shown as working', () => {
    const status = registerShortcuts(actions, deps(['Control+Alt+S']));
    expect(status.find((s) => s.id === 'screenshot')).toMatchObject({ registered: false, accelerators: [], problem: '⌃⌥S is held by another app.' });
  });
});

describe('the ⌃⌥Space that macOS keeps', () => {
  const on = '{\n    60 = { enabled = 1; value = { parameters = (32, 49, 262144); type = standard; }; };\n    61 = { enabled = 1; value = { parameters = (32, 49, 786432); type = standard; }; };\n}';
  const off = on.replace('61 = { enabled = 1', '61 = { enabled = 0');

  it('reads symbolic hot key 61: on, off, or absent (the default, which is on)', () => {
    expect(inputSourceKeyOn(on)).toBe(true);
    expect(inputSourceKeyOn(off)).toBe(false);
    expect(inputSourceKeyOn('{\n    64 = { enabled = 0; };\n}')).toBe(true);
    expect(inputSourceKeyOn(null)).toBe(true);
  });

  it('on a Mac that keeps it, the voice row says so and points at ⌃⌥N', async () => {
    registerShortcuts(actions, deps());
    const status = await checkSystemConflicts(deps([], on));
    expect(status.find((s) => s.id === 'voice')?.problem).toBe(INPUT_SOURCE_PROBLEM);
  });

  it('turned off in System Settings, or not a Mac: nothing to report', async () => {
    registerShortcuts(actions, deps());
    expect((await checkSystemConflicts(deps([], off))).find((s) => s.id === 'voice')?.problem).toBeNull();
    registerShortcuts(actions, deps());
    expect((await checkSystemConflicts(deps([], on, 'linux'))).find((s) => s.id === 'voice')?.problem).toBeNull();
  });
});

describe('pressing a key when the capture cannot start', () => {
  const guard = (access: string, run = vi.fn(async () => undefined)) => {
    const notify = vi.fn();
    const openSettings = vi.fn();
    return { run, notify, openSettings, press: guardCapture('voice', run, { platform: 'darwin', mediaAccess: () => access, notify, openSettings }) };
  };

  it('microphone off: says so and opens Settings › Permissions instead of doing nothing', async () => {
    const g = guard('denied');
    await g.press();
    expect(g.run).not.toHaveBeenCalled();
    expect(g.notify).toHaveBeenCalledWith('Voice notes need the microphone', expect.stringMatching(/Privacy & Security › Microphone/));
    expect(g.openSettings).toHaveBeenCalledWith('/settings/permissions');
  });

  it('allowed (or not asked yet): the capture starts', async () => {
    for (const access of ['granted', 'not-determined']) {
      const g = guard(access);
      await g.press();
      expect(g.run).toHaveBeenCalledTimes(1);
      expect(g.notify).not.toHaveBeenCalled();
    }
  });

  it('a capture that throws is reported, not swallowed', async () => {
    const g = guard('granted', vi.fn(async () => Promise.reject(new Error('overlay failed to load'))));
    await g.press();
    expect(g.notify).toHaveBeenCalledWith('Could not start a voice note', 'overlay failed to load');
  });
});
