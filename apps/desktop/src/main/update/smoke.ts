/**
 * OPENKT_SMOKE=1 + OPENKT_SMOKE_UPDATE=1 (CI job `update-smoke` only; OPENKT_UPDATE_FEED is honoured only here):
 *
 *   version N    checks the local feed → downloads → verifies → installs (spawns the swap script) → quits;
 *                it writes `<OPENKT_SMOKE_OUT>.n.json` with what it saw.
 *   version N+1  is relaunched by the swap script with the same switches, finds the pending-verify marker,
 *                becomes healthy (3 s here), deletes the previous copy and writes `<OPENKT_SMOKE_OUT>`.
 *
 * Never runs for users.
 */
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createUpdater } from './ipc';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function plistVersion(appPath: string): string {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export async function runUpdateSmoke(): Promise<void> {
  const out = process.env['OPENKT_SMOKE_OUT'] || join(tmpdir(), 'openkt-update-smoke.json');
  const result: Record<string, unknown> = { ok: false, version: app.getVersion(), pid: process.pid, steps: [] as string[] };
  const step = (s: string) => (result['steps'] as string[]).push(s);
  let target = `${out}.n.json`;
  const finish = (code: number) => {
    writeFileSync(target, JSON.stringify(result, null, 2));
    app.exit(code);
  };
  const timer = setTimeout(() => {
    result['error'] = 'update smoke timed out after 240 s';
    finish(1);
  }, 240_000);

  try {
    const { updater } = await createUpdater();
    const outcome = updater.launch();
    result['outcome'] = outcome.kind;
    result['appPath'] = updater.location().ok ? (updater.location() as { appPath: string }).appPath : null;
    result['mode'] = updater.mode;

    if (outcome.kind === 'verifying') {
      // We are N+1, relaunched by the swap script.
      target = out;
      step('relaunched');
      await sleep(3000);
      await updater.markHealthy();
      step('healthy');
      const s = updater.status();
      const appPath = String(result['appPath']);
      const dir = dirname(appPath);
      const leftovers = readdirSync(dir).filter((n) => n.startsWith(`${basename(appPath)}.old-`) || n.startsWith('.openkt-update-'));
      Object.assign(result, {
        plistVersion: plistVersion(appPath),
        whatsNew: s.whatsNew,
        leftovers,
        oldCopyGone: leftovers.length === 0,
      });
      if (!s.whatsNew) throw new Error('no "what\'s new" after the update');
      if (leftovers.length) throw new Error(`left behind: ${leftovers.join(', ')}`);
      result['ok'] = true;
      clearTimeout(timer);
      return finish(0);
    }

    // We are N.
    step('launched');
    if (updater.mode !== 'custom') throw new Error(`expected the custom updater on an ad-hoc build, got ${updater.mode}`);
    const loc = updater.location();
    if (!loc.ok) throw new Error(`location refused: ${loc.message}`);
    const checked = await updater.check();
    result['checked'] = { phase: checked.phase, available: checked.available, error: checked.error };
    if (!checked.available) throw new Error(`no update offered (phase ${checked.phase}, ${checked.error ?? 'no error'})`);
    step('check');
    await updater.idle();
    const ready = updater.status();
    result['ready'] = { phase: ready.phase, error: ready.error };
    if (ready.phase !== 'ready') throw new Error(`download/verify ended in ${ready.phase}: ${ready.error}`);
    step('download+verify');
    const staged = readdirSync(dirname(loc.appPath)).filter((n) => n.startsWith('.openkt-update-'));
    result['staged'] = staged;
    if (staged.length !== 1 || !existsSync(join(dirname(loc.appPath), staged[0]!, 'OpenKT.app'))) throw new Error('no staged bundle next to the app');
    step('install');
    result['ok'] = true;
    clearTimeout(timer);
    writeFileSync(target, JSON.stringify(result, null, 2));
    const after = await updater.install();
    // install() quits on success; getting here with an error means it did not start.
    if (after.phase !== 'installing') {
      result['ok'] = false;
      result['error'] = `install did not start: ${after.phase} ${after.error}`;
      finish(1);
    }
  } catch (e) {
    result['error'] = (e as Error).message;
    clearTimeout(timer);
    finish(1);
  }
}
