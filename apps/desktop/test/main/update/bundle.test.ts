import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseTeamIdentifier, stripQuarantine, teamIdentifier, unzipBundle, verifyBundle } from '../../../src/main/update/bundle';
import { fakeApp, fakeTools, zipApp } from './helpers';

let dir = '';
let tools: ReturnType<typeof fakeTools>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openkt-upd-bundle-'));
  tools = fakeTools(join(dir, 'bin'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const expected = { bundleId: 'ai.openkt.desktop', version: '0.3.9' };

describe('bundle verification (fake plutil / codesign / ditto)', () => {
  it('expands the archive with ditto and accepts our bundle at the promised version', async () => {
    const src = fakeApp(join(dir, 'src', 'OpenKT.app'), { version: '0.3.9' });
    const zip = join(dir, 'u.zip');
    zipApp(src, zip);
    mkdirSync(join(dir, 'stage'));
    const app = await unzipBundle(zip, join(dir, 'stage'), tools);
    expect(app).toBe(join(dir, 'stage', 'OpenKT.app'));
    await verifyBundle(app, expected, tools);
    const calls = readFileSync(tools.calls, 'utf8');
    expect(calls).toContain(`ditto -x -k ${zip} ${join(dir, 'stage')}`);
    expect(calls).toContain(`codesign --verify --deep --strict ${app}`);
    expect(calls).toContain('plutil -extract CFBundleIdentifier raw -o -');
  });

  it('rejects another bundle identifier', async () => {
    const app = fakeApp(join(dir, 'Evil.app'), { id: 'com.evil.app', version: '0.3.9' });
    await expect(verifyBundle(app, expected, tools)).rejects.toMatchObject({ code: 'wrong_bundle' });
  });

  it('rejects a bundle whose version differs from the feed', async () => {
    const app = fakeApp(join(dir, 'OpenKT.app'), { version: '0.3.8' });
    await expect(verifyBundle(app, expected, tools)).rejects.toMatchObject({ code: 'wrong_version' });
  });

  it('rejects a bundle whose signature does not verify, before looking further', async () => {
    const app = fakeApp(join(dir, 'OpenKT.app'), { version: '0.3.9', sealed: false });
    await expect(verifyBundle(app, expected, tools)).rejects.toMatchObject({ code: 'bad_signature', message: expect.stringContaining('invalid signature') });
  });

  it('a Developer ID build only accepts an update from the same team (an ad-hoc bundle is refused)', async () => {
    const app = fakeApp(join(dir, 'OpenKT.app'), { version: '0.3.9' });
    await expect(verifyBundle(app, { ...expected, teamId: 'ABCDE12345' }, tools)).rejects.toMatchObject({ code: 'bad_signature', message: expect.stringContaining('signed by nobody') });
    await verifyBundle(app, { ...expected, teamId: null }, tools);
  });

    it('rejects an archive with no app, two apps, or garbage', async () => {
    const empty = join(dir, 'empty');
    mkdirSync(join(empty, 'x'), { recursive: true });
    writeFileSync(join(empty, 'x', 'readme'), 'hi');
    const zip1 = join(dir, 'none.zip');
    zipApp(join(empty, 'x'), zip1);
    mkdirSync(join(dir, 's1'));
    await expect(unzipBundle(zip1, join(dir, 's1'), tools)).rejects.toMatchObject({ code: 'no_bundle' });

    const two = join(dir, 'two');
    fakeApp(join(two, 'A.app'), { version: '0.3.9' });
    fakeApp(join(two, 'B.app'), { version: '0.3.9' });
    const zip2 = join(dir, 'two.zip');
    execFileSync('zip', ['-qry', zip2, 'A.app', 'B.app'], { cwd: two });
    mkdirSync(join(dir, 's2'));
    await expect(unzipBundle(zip2, join(dir, 's2'), tools)).rejects.toMatchObject({ code: 'no_bundle' });

    writeFileSync(join(dir, 'garbage.zip'), 'not a zip');
    mkdirSync(join(dir, 's3'));
    await expect(unzipBundle(join(dir, 'garbage.zip'), join(dir, 's3'), tools)).rejects.toMatchObject({ code: 'unzip_failed' });
  });

  it('strips the quarantine attribute recursively', async () => {
    await stripQuarantine('/x/OpenKT.app', tools);
    expect(readFileSync(tools.calls, 'utf8')).toContain('xattr -dr com.apple.quarantine /x/OpenKT.app');
  });

  it('reads the TeamIdentifier: ad-hoc builds have none', async () => {
    expect(parseTeamIdentifier('Identifier=ai.openkt.desktop\nTeamIdentifier=not set\n')).toBeNull();
    expect(parseTeamIdentifier('Authority=Developer ID Application: OpenKT (ABCDE12345)\nTeamIdentifier=ABCDE12345\n')).toBe('ABCDE12345');
    expect(parseTeamIdentifier('code object is not signed at all')).toBeNull();
    expect(await teamIdentifier(join(dir, 'whatever.app'), tools)).toBeNull();
    expect(existsSync(tools.calls)).toBe(true);
  });
});
