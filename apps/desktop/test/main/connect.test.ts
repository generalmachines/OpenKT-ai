import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { shareSignIn } from '../../src/main/connect/ipc';

// The app hands its sign-in to the shared credentials store the hooks read (packages/connect/README.md).
describe('main/connect shareSignIn', () => {
  let home: string;
  beforeEach(() => void (home = mkdtempSync(join(tmpdir(), 'okt-main-connect-'))));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const fake = (current: { server: string; token: string | null; source: string }) => ({
    readCredentials: vi.fn(async () => current),
    writeCredentials: vi.fn(async () => 'file' as const),
  });

  it('stores a real sign-in when the store has none', async () => {
    const c = fake({ server: 'https://api.openkt.ai', token: null, source: 'none' });
    expect(await shareSignIn(c as never, { home }, { server: 'https://api.openkt.ai/', token: 'okt_pat_abc' })).toBe('file');
    expect(c.writeCredentials).toHaveBeenCalledWith({ home }, { server: 'https://api.openkt.ai', token: 'okt_pat_abc' });
  });

  it('leaves the store alone when it already holds that sign-in, or the environment overrides it', async () => {
    expect(await shareSignIn(fake({ server: 'https://api.openkt.ai', token: 'okt_pat_abc', source: 'file' }) as never, { home }, { server: 'https://api.openkt.ai', token: 'okt_pat_abc' })).toBe('unchanged');
    expect(await shareSignIn(fake({ server: 'https://x', token: 'okt_pat_env', source: 'env' }) as never, { home }, { server: 'https://api.openkt.ai', token: 'okt_pat_abc' })).toBe('unchanged');
  });

  it('ignores anything that is not a server session (sample data, garbage)', async () => {
    const c = fake({ server: 'https://api.openkt.ai', token: null, source: 'none' });
    for (const bad of [undefined, {}, { server: 'https://api.openkt.ai', token: 'mock-token' }, { server: 'file:///etc', token: 'okt_pat_abc' }, { server: 'https://a', token: 'okt_pat_a"b' }]) {
      expect(await shareSignIn(c as never, { home }, bad)).toBe('unchanged');
    }
    expect(c.writeCredentials).not.toHaveBeenCalled();
  });
});
