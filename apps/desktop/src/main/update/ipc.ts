/**
 * Electron wiring for the updater (src/main/update/updater.ts): IPC, the "Check for Updates…" menu action,
 * the launch-time checks (pending-verify, "Move to Applications", "Go back to the previous version"),
 * the 30 s / 6 h schedule and the healthy-start timer. Nothing here runs in tests.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IpcChannel, UpdateStatusDto } from '../../shared/ipc';
import { teamIdentifier } from './bundle';
import { resolveFeedConfig, type FeedConfig } from './feed';
import { bundlePathFromExe } from './location';
import { createSignedAdapter } from './signed';
import { Updater, type SignedAdapter } from './updater';

/** electron-builder.yml `appId`; the update's CFBundleIdentifier must equal it. */
export const BUNDLE_ID = 'ai.openkt.desktop';
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** How long a freshly updated version must run before it counts as healthy (and the previous copy is deleted). */
const HEALTHY_AFTER_MS = 20_000;

export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
  channel: string;
  /** Set by CI when the build was Developer ID signed (OPENKT_SIGNED=1 / CSC_LINK present). */
  signed: boolean;
}

/** CI stamps `openktBuild` into apps/desktop/package.json before packaging (not committed). */
export function readBuildInfo(): BuildInfo {
  let extra: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { openktBuild?: Record<string, unknown> };
    extra = pkg.openktBuild ?? {};
  } catch {
    /* dev build */
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    version: app.getVersion(),
    commit: str(extra['commit']),
    builtAt: str(extra['builtAt']),
    channel: str(extra['channel']) || 'stable',
    signed: extra['signed'] === true || process.env['OPENKT_SIGNED'] === '1',
  };
}

export const isUpdateSmoke = (): boolean => process.env['OPENKT_SMOKE'] === '1' && process.env['OPENKT_SMOKE_UPDATE'] === '1';

/** The smoke run relaunches the new version with the same switches (`open` does not pass the environment on). */
function smokeOpenArgs(): string[] {
  if (!isUpdateSmoke()) return [];
  const args: string[] = [];
  for (const k of ['OPENKT_SMOKE', 'OPENKT_SMOKE_UPDATE', 'OPENKT_UPDATE_FEED', 'OPENKT_SMOKE_OUT']) {
    const v = process.env[k];
    if (v) args.push('--env', `${k}=${v}`);
  }
  const log = process.env['OPENKT_SMOKE_LOG'];
  if (log) args.push('--env', `OPENKT_SMOKE_LOG=${log}`, '--stdout', log, '--stderr', log);
  return args;
}

/** Developer ID builds have a TeamIdentifier (`codesign -dv`); ad-hoc builds have none. */
async function runningTeamId(appPath: string): Promise<string | null> {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  return teamIdentifier(appPath);
}

function signedAdapter(feed: FeedConfig): SignedAdapter | null {
  try {
    return createSignedAdapter({
      vendorPath: join(__dirname, '..', '..', 'vendor', 'electron-updater.cjs'),
      feed,
      cacheDir: join(app.getPath('userData'), 'updates', 'signed'),
      log: (m) => console.log(`[update] ${String(m)}`),
    });
  } catch (e) {
    console.error('[update] electron-updater unavailable, using the verified self-update:', (e as Error).message);
    return null;
  }
}

export async function createUpdater(): Promise<{ updater: Updater; build: BuildInfo }> {
  const build = readBuildInfo();
  const appPath = bundlePathFromExe(app.getPath('exe'));
  const feed = resolveFeedConfig(process.env);
  const teamId = await runningTeamId(appPath);
  // The CI smoke always proves the verified self-update; Squirrel.Mac cannot be exercised without a Developer ID.
  const signed = !isUpdateSmoke() && (build.signed || teamId !== null) ? signedAdapter(feed) : null;
  const updater = new Updater({
    version: build.version,
    commit: build.commit,
    builtAt: build.builtAt,
    channel: build.channel,
    bundleId: BUNDLE_ID,
    teamId,
    osVersion: process.getSystemVersion(),
    appPath,
    platform: process.platform,
    packaged: app.isPackaged,
    feed,
    dataDir: join(app.getPath('userData'), 'updates'),
    pid: process.pid,
    signed,
    openArgs: smokeOpenArgs(),
    quit: () => {
      app.quit();
      setTimeout(() => app.exit(0), 10_000).unref();
    },
  });
  return { updater, build };
}

let instance: Updater | null = null;

/** "Check for Updates…" (app menu, tray): open About and ask the feed now. */
export function checkForUpdatesFromMenu(openMain: (route: string) => unknown): void {
  void openMain('/settings/about');
  void instance?.check();
}

/** Electron's moveToApplicationsFolder: copies to /Applications, quits and relaunches from there. */
function moveToApplications(): void {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return;
  app.moveToApplicationsFolder({
    conflictHandler: (type) => {
      if (type === 'existsAndRunning') {
        dialog.showMessageBoxSync({ type: 'info', message: 'Another copy of OpenKT is running from Applications.', detail: 'Quit it first, then choose Move to Applications again.' });
        return false;
      }
      return (
        dialog.showMessageBoxSync({
          type: 'question',
          buttons: ['Replace', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: 'Applications already has a copy of OpenKT.',
          detail: 'Replace it with this one?',
        }) === 0
      );
    },
  });
  // On success Electron quits and relaunches from /Applications; on refusal we are still here.
}

/** First run from the disk image (or an App-Translocated copy): offer to move once; "Not now" is remembered. */
async function offerMoveOnce(updater: Updater): Promise<void> {
  const loc = updater.location();
  if (loc.ok || !loc.canMove || (loc.reason !== 'dmg' && loc.reason !== 'translocated')) return;
  const flag = join(app.getPath('userData'), 'updates', 'move-declined');
  if (existsSync(flag)) return;
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Move OpenKT to Applications?',
    detail: `${loc.message}\n\nOpenKT keeps itself up to date once it lives in Applications.`,
  });
  if (r.response === 0) return moveToApplications();
  try {
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, new Date().toISOString());
  } catch {
    /* ask again next time */
  }
}

async function offerRollback(updater: Updater): Promise<void> {
  const s = updater.status();
  if (!s.rollback) return;
  const r = await dialog.showMessageBox({
    type: 'warning',
    buttons: [`Go back to ${s.rollback.to}`, `Keep ${s.rollback.from}`],
    defaultId: 0,
    cancelId: 1,
    message: `OpenKT ${s.rollback.from} did not start properly.`,
    detail: `It stopped twice before it finished starting. You can go back to ${s.rollback.to}, the version you had before; ${s.rollback.from} will not be offered again.`,
  });
  if (r.response === 0) await updater.rollback();
  else await updater.keep();
}

/**
 * Registers the update IPC and starts the schedule. Call once from app.whenReady (not in the smoke modes).
 */
export async function registerUpdateIpc(windows: () => BrowserWindow[]): Promise<Updater> {
  const ready = createUpdater().then(({ updater }) => updater);
  const handle = (channel: IpcChannel, fn: (u: Updater, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (_e, ...args) => fn(await ready, ...args) as Promise<UpdateStatusDto> | UpdateStatusDto);
  handle('update:status', (u) => u.status());
  handle('update:check', (u) => u.check());
  handle('update:download', (u) => u.download());
  handle('update:install', (u) => u.install());
  handle('update:set-auto', (u, on) => u.setAuto(on === true));
  handle('update:move-to-applications', (u) => {
    moveToApplications();
    return u.status();
  });
  handle('update:rollback', (u) => u.rollback());
  handle('update:seen', (u) => u.seen());

  const updater = await ready;
  instance = updater;
  updater.onChange((s) => {
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.send('update:event' satisfies IpcChannel, s);
  });

  const outcome = updater.launch();
  if (outcome.kind === 'verifying') setTimeout(() => void updater.markHealthy(), isUpdateSmoke() ? 3000 : HEALTHY_AFTER_MS).unref();
  void updater.cleanup();

  if (outcome.kind === 'offer-rollback') void offerRollback(updater);
  else void offerMoveOnce(updater);
  if (updater.mode !== 'disabled') {
    setTimeout(() => void updater.check(), FIRST_CHECK_MS).unref();
    setInterval(() => void updater.check(), CHECK_EVERY_MS).unref();
  }
  return updater;
}
