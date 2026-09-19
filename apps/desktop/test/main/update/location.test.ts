import { constants } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessLocation, bundlePathFromExe, type LocationInput } from '../../../src/main/update/location';

const err = (code: string) => Object.assign(new Error(code), { code });
function fsWith(denied: Record<string, string>): NonNullable<LocationInput['fs']> {
  return {
    statSync: (() => ({})) as unknown as NonNullable<LocationInput['fs']>['statSync'],
    accessSync: ((p: string, mode?: number) => {
      expect(mode).toBe(constants.W_OK);
      if (denied[p]) throw err(denied[p]!);
    }) as NonNullable<LocationInput['fs']>['accessSync'],
  };
}
const at = (appPath: string, denied: Record<string, string> = {}, over: Partial<LocationInput> = {}) =>
  assessLocation({ appPath, platform: 'darwin', packaged: true, fs: fsWith(denied), ...over });

describe('where the app runs from', () => {
  it('finds the bundle from the executable path', () => {
    expect(bundlePathFromExe('/Applications/OpenKT.app/Contents/MacOS/OpenKT')).toBe('/Applications/OpenKT.app');
    expect(bundlePathFromExe('/Users/a/My Apps/Open KT.app/Contents/MacOS/OpenKT')).toBe('/Users/a/My Apps/Open KT.app');
    expect(bundlePathFromExe('/usr/lib/electron/electron')).toBe('/usr/lib/electron/electron');
  });

  it('allows a writable install in Applications', () => {
    expect(at('/Applications/OpenKT.app')).toEqual({ ok: true, appPath: '/Applications/OpenKT.app', dir: '/Applications' });
  });

  it('refuses to update from the mounted disk image and offers the move', () => {
    const r = at('/Volumes/OpenKT 0.3.9-arm64/OpenKT.app');
    expect(r).toMatchObject({ ok: false, reason: 'dmg', canMove: true });
    expect(r.ok === false && r.message).toMatch(/Drag it to Applications/);
  });

  it('refuses an App-Translocated copy', () => {
    expect(at('/private/var/folders/x/T/AppTranslocation/ABCD-1234/d/OpenKT.app')).toMatchObject({ ok: false, reason: 'translocated', canMove: true });
  });

  it('refuses a read-only volume and a folder it cannot write to, and says why', () => {
    expect(at('/Users/a/ro/OpenKT.app', { '/Users/a/ro/OpenKT.app': 'EROFS' })).toMatchObject({ ok: false, reason: 'read_only' });
    const r = at('/Applications/OpenKT.app', { '/Applications': 'EACCES' });
    expect(r).toMatchObject({ ok: false, reason: 'not_writable', canMove: true });
    expect(r.ok === false && r.message).toContain('/Applications');
    expect(at('/Applications/OpenKT.app', { '/Applications/OpenKT.app': 'EPERM' })).toMatchObject({ ok: false, reason: 'not_writable' });
  });

  it('is off for dev builds and other platforms', () => {
    expect(at('/x/OpenKT.app', {}, { packaged: false })).toMatchObject({ ok: false, reason: 'not_packaged', canMove: false });
    expect(at('/x/OpenKT.app', {}, { platform: 'linux' })).toMatchObject({ ok: false, reason: 'unsupported_platform' });
    expect(at('/usr/lib/electron/electron')).toMatchObject({ ok: false, reason: 'not_a_bundle' });
  });
});
