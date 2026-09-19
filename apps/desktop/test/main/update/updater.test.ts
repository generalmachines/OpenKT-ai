/**
 * The whole custom path on Linux: a local feed + zip over http://127.0.0.1, fake plutil/codesign/ditto/xattr/open,
 * the real swap script (/bin/sh, /bin/mv), then a "relaunch" as the new version.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Updater, explainSwapLog, isOldCopyOf, type UpdaterOptions } from '../../../src/main/update/updater';
import { fakeApp, fakeTools, startServer, zipApp, type FixtureServer } from './helpers';

let srv: FixtureServer;
let root = '';
let apps = '';
let appPath = '';
let data = '';
let tools: ReturnType<typeof fakeTools>;
let holder: ChildProcess | null = null;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function publish(version: string, opts: { id?: string; sealed?: boolean } = {}): void {
  const src = fakeApp(join(root, 'build', version, 'OpenKT.app'), { version, ...opts });
  const zip = zipApp(src, join(root, 'build', version, 'OpenKT.zip'));
  srv.files.set(`/releases/${version}/OpenKT-${version}-arm64.zip`, zip);
  srv.files.set(
    '/latest.json',
    Buffer.from(
      JSON.stringify({
        version,
        channel: 'stable',
        released_at: '2026-09-19T10:00:00Z',
        commit: 'abc',
        notes: [`What changed in ${version}`],
        min_os: '13.3',
        files: { zip: { url: `${srv.base}/releases/${version}/OpenKT-${version}-arm64.zip`, sha256: sha(zip), size: zip.length } },
      }),
    ),
  );
}

function make(version: string, over: Partial<UpdaterOptions> = {}): Updater & { quits: number } {
  let quits = 0;
  const u = new Updater({
    version,
    bundleId: 'ai.openkt.desktop',
    appPath,
    platform: 'darwin',
    packaged: true,
    osVersion: '14.6.1',
    feed: { url: `${srv.base}/latest.json`, allowLoopbackHttp: true },
    dataDir: data,
    pid: holder!.pid!,
    tools,
    backoffMs: 1,
    quit: () => {
      quits += 1;
      holder?.kill();
    },
    ...over,
  }) as Updater & { quits: number };
  Object.defineProperty(u, 'quits', { get: () => quits });
  return u;
}

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const plistVersion = (p: string) => /CFBundleShortVersionString=(.*)/.exec(readFileSync(join(p, 'Contents', 'Info.plist'), 'utf8'))?.[1];

beforeAll(async () => {
  srv = await startServer();
});
afterAll(() => srv.close());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openkt-upd-e2e-'));
  apps = join(root, "Apps & Ana's things");
  appPath = fakeApp(join(apps, 'OpenKT.app'), { version: '0.3.8' });
  data = join(root, 'userData', 'updates');
  tools = fakeTools(join(root, 'bin'));
  srv.files.clear();
  srv.seen.length = 0;
  Object.assign(srv.behaviour, { cutAfter: 0, redirect: {}, status: {} });
  holder = spawn('sleep', ['30']);
  return () => {
    holder?.kill();
    rmSync(root, { recursive: true, force: true });
  };
});

describe('Updater — the custom (ad-hoc) path', () => {
  it('checks, downloads, verifies, swaps, relaunches, becomes healthy and deletes the old copy', async () => {
    publish('0.3.9');
    const n = make('0.3.8');
    expect(n.launch().kind).toBe('normal');
    const events: string[] = [];
    n.onChange((s) => events.push(s.phase));

    const checked = await n.check();
    expect(checked.available).toMatchObject({ version: '0.3.9', notes: ['What changed in 0.3.9'] });
    await n.idle();
    const ready = n.status();
    expect(ready.phase).toBe('ready');
    expect(ready.error).toBeNull();
    expect(events).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'verifying', 'ready']));
    const staged = readdirSync(apps).filter((x) => x.startsWith('.openkt-update-0.3.9-'));
    expect(staged).toHaveLength(1);
    expect(plistVersion(join(apps, staged[0]!, 'OpenKT.app'))).toBe('0.3.9');
    expect(readFileSync(tools.calls, 'utf8')).toContain('xattr -dr com.apple.quarantine');

    const installing = await n.install();
    expect(installing.phase).toBe('installing');
    expect(n.quits).toBe(1);
    await until(() => readFileSync(tools.calls, 'utf8').includes('open -n'), 'the relaunch');
    expect(plistVersion(appPath)).toBe('0.3.9');
    const old = readdirSync(apps).filter((x) => x.startsWith('OpenKT.app.old-'));
    expect(old).toHaveLength(1);
    expect(plistVersion(join(apps, old[0]!))).toBe('0.3.8');
    expect(readdirSync(apps).filter((x) => x.startsWith('.openkt-update-'))).toHaveLength(0);
    expect(readFileSync(tools.calls, 'utf8')).toContain(`open -n ${appPath}`);

    // Relaunched as 0.3.9.
    holder = spawn('sleep', ['30']);
    const n1 = make('0.3.9');
    expect(n1.launch()).toMatchObject({ kind: 'verifying', starts: 1 });
    expect(n1.status().whatsNew).toBeNull();
    await n1.markHealthy();
    expect(readdirSync(apps).sort()).toEqual(['OpenKT.app']);
    expect(n1.status().whatsNew).toEqual({ version: '0.3.9', from: '0.3.8', notes: ['What changed in 0.3.9'] });
    expect(n1.seen().whatsNew).toBeNull();
    // Nothing newer: up to date, and the download folder is cleaned up.
    expect((await n1.check()).phase).toBe('up-to-date');
    await n1.cleanup();
    expect(existsSync(join(data, '0.3.9'))).toBe(false);
  });

  it('with "Download updates automatically" off, it only reports the update until asked', async () => {
    publish('0.3.9');
    const n = make('0.3.8');
    await n.setAuto(false);
    expect((await n.check()).phase).toBe('available');
    await n.idle();
    expect(srv.seen.map((s) => s.path)).toEqual(['/latest.json']);
    expect((await n.download()).phase).toBe('ready');
    // The choice persists.
    expect(make('0.3.8').status().auto).toBe(false);
  });

  it('never downgrades', async () => {
    publish('0.3.7');
    const n = make('0.3.8');
    const s = await n.check();
    expect(s.phase).toBe('up-to-date');
    expect(s.available).toBeNull();
    await n.idle();
    expect(srv.seen.map((x) => x.path)).toEqual(['/latest.json']);
    expect((await n.install()).phase).toBe('up-to-date');
    expect(n.quits).toBe(0);
  });

  it('rejects an update that is not our bundle, deletes it and never installs it', async () => {
    publish('0.3.9', { id: 'com.evil.app' });
    const n = make('0.3.8');
    await n.check();
    await n.idle();
    const s = n.status();
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/rejected.*com\.evil\.app/);
    expect(existsSync(join(data, '0.3.9'))).toBe(false);
    expect(readdirSync(apps)).toEqual(['OpenKT.app']);
    expect((await n.install()).phase).toBe('error');
    expect(n.quits).toBe(0);
    expect(plistVersion(appPath)).toBe('0.3.8');
  });

  it('rejects an update whose signature does not verify', async () => {
    publish('0.3.9', { sealed: false });
    const n = make('0.3.8');
    await n.check();
    await n.idle();
    expect(n.status()).toMatchObject({ phase: 'error', error: expect.stringMatching(/signature/) });
    expect(readdirSync(apps)).toEqual(['OpenKT.app']);
  });

  it('rejects a zip whose sha256 does not match the feed', async () => {
    publish('0.3.9');
    const feed = JSON.parse(srv.files.get('/latest.json')!.toString());
    feed.files.zip.sha256 = 'c'.repeat(64);
    srv.files.set('/latest.json', Buffer.from(JSON.stringify(feed)));
    const n = make('0.3.8');
    await n.check();
    await n.idle();
    expect(n.status()).toMatchObject({ phase: 'error', error: expect.stringMatching(/checksum/) });
    expect(readdirSync(join(data, '0.3.9'))).toEqual([]);
  });

  it('running from the disk image: reports the update, refuses to download or install, says why', async () => {
    publish('0.3.9');
    const dmgApp = '/Volumes/OpenKT 0.3.8-arm64/OpenKT.app';
    const n = make('0.3.8', { appPath: dmgApp });
    const s = await n.check();
    expect(s.phase).toBe('available');
    expect(s.location).toMatchObject({ ok: false, canMove: true });
    await n.idle();
    expect(srv.seen.map((x) => x.path)).toEqual(['/latest.json']);
    const d = await n.download();
    expect(d.error).toMatch(/Drag it to Applications/);
    expect(n.quits).toBe(0);
  });

  it('a feed that is not published yet is "up to date", not an error', async () => {
    const n = make('0.3.8');
    const s = await n.check();
    expect(s).toMatchObject({ phase: 'up-to-date', error: null });
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it('an unreachable feed is an error in words, and nothing else changes', async () => {
    const n = make('0.3.8', { feed: { url: 'http://127.0.0.1:1/latest.json', allowLoopbackHttp: true } });
    expect((await n.check())).toMatchObject({ phase: 'error', error: expect.stringMatching(/could not reach the update server/) });
  });

  it('offers "Go back" after two unhealthy starts, rolls back and blocks the version', async () => {
    publish('0.3.9');
    const n = make('0.3.8');
    await n.check();
    await n.idle();
    await n.install();
    await until(() => readFileSync(tools.calls, 'utf8').includes('open -n'), 'the relaunch');

    // 0.3.9 starts twice and dies before it is healthy.
    for (const starts of [1, 2]) expect(make('0.3.9').launch()).toMatchObject({ kind: 'verifying', starts });
    holder = spawn('sleep', ['30']);
    const bad = make('0.3.9');
    expect(bad.launch().kind).toBe('offer-rollback');
    expect(bad.status().rollback).toEqual({ from: '0.3.9', to: '0.3.8' });
    writeFileSync(tools.calls, '');
    await bad.rollback();
    expect(bad.quits).toBe(1);
    await until(() => readFileSync(tools.calls, 'utf8').includes('open -n'), 'the relaunch after rollback');
    expect(plistVersion(appPath)).toBe('0.3.8');
    expect(readdirSync(apps)).toEqual(['OpenKT.app']);

    // Back on 0.3.8: 0.3.9 is never offered again.
    holder = spawn('sleep', ['30']);
    const back = make('0.3.8');
    expect(back.launch().kind).toBe('normal');
    expect((await back.check()).phase).toBe('up-to-date');
  });

  it('explains a swap that macOS refused, on the next start of the old version', async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'state.json'), JSON.stringify({ auto: true, pending: { version: '0.3.9', from: '0.3.8', oldAppPath: `${appPath}.old-1`, installedAt: '', starts: 0 } }));
    writeFileSync(join(data, 'swap.log'), 'swap: start\nswap: could not move the old bundle aside (App Management permission?)\n');
    const n = make('0.3.8');
    expect(n.launch().kind).toBe('swap-failed');
    expect(n.status()).toMatchObject({ phase: 'error', error: expect.stringMatching(/App Management/) });
  });

  it('only ever deletes <app>.old-<digits>', () => {
    expect(isOldCopyOf('/Applications/OpenKT.app', '/Applications/OpenKT.app.old-1726740000000')).toBe(true);
    expect(isOldCopyOf('/Applications/OpenKT.app', '/Applications/OpenKT.app')).toBe(false);
    expect(isOldCopyOf('/Applications/OpenKT.app', '/Applications/OpenKT.app.old-1/../../Users')).toBe(false);
    expect(isOldCopyOf('/Applications/OpenKT.app', '/Applications')).toBe(false);
    expect(isOldCopyOf('/Applications/OpenKT.app', '/Applications/OpenKT.app.old-')).toBe(false);
    expect(explainSwapLog('')).toMatch(/current version was kept/);
  });
});
