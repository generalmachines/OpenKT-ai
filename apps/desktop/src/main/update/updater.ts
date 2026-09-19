/**
 * The updater: check → download → verify → "Restart to update" → swap → relaunch → healthy.
 * Pure Node (no Electron import) so it runs under vitest on Linux with fake tools; src/main/update/ipc.ts
 * wires it to Electron (IPC, menu, timers, dialogs).
 *
 * Two install paths read the same feed:
 *   custom  — ad-hoc signed builds (today): verified zip → staged bundle next to the app → detached swap script.
 *   signed  — Developer ID builds: electron-updater (Squirrel.Mac), which requires a matching signature.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UpdatePhaseDto, UpdateStatusDto } from '../../shared/ipc';
import { BundleError, SYSTEM_TOOLS, stripQuarantine, unzipBundle, verifyBundle, type Tools } from './bundle';
import { UpdateDownloadError, downloadUpdate } from './download';
import { FeedError, decide, fetchFeed, type Feed, type FeedConfig } from './feed';
import { assessLocation, type LocationAssessment, type LocationInput } from './location';
import { compareSemver, parseSemver } from './semver';
import { markHealthy, markRolledBack, onLaunch, readState, writeState, type LaunchOutcome, type UpdaterState } from './state';
import { spawnSwap } from './swap';

/** electron-updater behind a small interface (src/main/update/signed.ts); absent on ad-hoc builds. */
export interface SignedAdapter {
  download(feed: Feed, onProgress: (p: { receivedBytes: number; totalBytes: number; bytesPerSec: number }) => void): Promise<void>;
  /** quitAndInstall: Squirrel.Mac swaps the bundle and relaunches. */
  install(): void;
}

export interface UpdaterOptions {
  version: string;
  commit?: string;
  builtAt?: string;
  channel?: string;
  bundleId: string;
  /** The running app's TeamIdentifier (null for ad-hoc builds): an update must match it. */
  teamId?: string | null;
  /** process.getSystemVersion(), e.g. "14.5.0". */
  osVersion?: string;
  /** The running `.app` bundle. */
  appPath: string;
  platform: NodeJS.Platform;
  packaged: boolean;
  feed: FeedConfig;
  /** userData/updates */
  dataDir: string;
  pid: number;
  /** Quits the app so the swap script can run. */
  quit: () => void;
  signed?: SignedAdapter | null;
  tools?: Tools;
  fetch?: typeof fetch;
  /** Relaunch options for `open` (smoke run only). */
  openArgs?: string[];
  locationFs?: LocationInput['fs'];
  now?: () => Date;
  backoffMs?: number;
}

interface Staged {
  version: string;
  app: string;
  stageDir: string;
}

const STAGE_PREFIX = '.openkt-update-';

/** `/Applications/OpenKT.app.old-1726740000000` for `/Applications/OpenKT.app` — nothing else is ever deleted. */
export function isOldCopyOf(appPath: string, candidate: string): boolean {
  if (!candidate.startsWith(`${appPath}.old-`)) return false;
  return /^\d+$/.test(candidate.slice(appPath.length + '.old-'.length));
}

/** The swap script's log line, turned into something a person can act on. */
export function explainSwapLog(log: string): string {
  if (/App Management/.test(log)) {
    return 'macOS did not let OpenKT replace itself. Allow OpenKT in System Settings → Privacy & Security → App Management, then choose Restart to update again.';
  }
  if (/could not move the new bundle into place/.test(log)) return 'The update could not be moved into place; your current version was kept.';
  if (/gave up waiting/.test(log)) return 'OpenKT did not quit in time, so the update was not installed. Try again.';
  if (/new bundle missing/.test(log)) return 'The prepared update was removed before it could be installed. It will download again.';
  return 'The last update was not installed; your current version was kept.';
}

export class Updater {
  private state: UpdaterState;
  private phase: UpdatePhaseDto = 'idle';
  private feed: Feed | null = null;
  private progress: UpdateStatusDto['progress'] = null;
  private error: string | null = null;
  private staged: Staged | null = null;
  private launchOutcome: LaunchOutcome = { kind: 'normal' };
  private busy: Promise<unknown> | null = null;
  private readonly listeners = new Set<(s: UpdateStatusDto) => void>();
  private readonly statePath: string;
  private readonly tools: Tools;
  private readonly now: () => Date;
  private readonly channel: string;

  constructor(private readonly o: UpdaterOptions) {
    this.statePath = join(o.dataDir, 'state.json');
    this.state = readState(this.statePath);
    this.tools = o.tools ?? SYSTEM_TOOLS;
    this.now = o.now ?? (() => new Date());
    this.channel = o.channel || 'stable';
  }

  get mode(): UpdateStatusDto['mode'] {
    if (this.o.platform !== 'darwin' || !this.o.packaged) return 'disabled';
    return this.o.signed ? 'signed' : 'custom';
  }

  location(): LocationAssessment {
    return assessLocation({ appPath: this.o.appPath, platform: this.o.platform, packaged: this.o.packaged, fs: this.o.locationFs });
  }

  onChange(listener: (s: UpdateStatusDto) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  private save(): void {
    try {
      writeState(this.statePath, this.state);
    } catch {
      /* a read-only userData is not worth crashing over; the state is advisory */
    }
  }

  status(): UpdateStatusDto {
    const loc = this.location();
    const lu = this.state.lastUpdate;
    const p = this.state.pending;
    return {
      version: this.o.version,
      commit: this.o.commit ?? '',
      builtAt: this.o.builtAt ?? '',
      channel: this.channel,
      mode: this.mode,
      phase: this.phase,
      auto: this.state.auto,
      lastCheckedAt: this.state.lastCheckedAt,
      available: this.feed ? { version: this.feed.version, notes: this.feed.notes, releasedAt: this.feed.released_at, size: this.feed.files.zip.size } : null,
      progress: this.phase === 'downloading' ? this.progress : null,
      error: this.error,
      location: loc.ok ? { ok: true, message: null, canMove: false } : { ok: false, message: loc.message, canMove: loc.canMove },
      whatsNew: lu && !lu.seen && lu.version === this.o.version ? { version: lu.version, from: lu.from, notes: lu.notes } : null,
      rollback: this.launchOutcome.kind === 'offer-rollback' && p ? { from: p.version, to: p.from } : null,
    };
  }

  // ── launch / health ────────────────────────────────────────────────────

  /** Call once at startup, before anything else touches the state. */
  launch(): LaunchOutcome {
    const r = onLaunch(this.state, this.o.version);
    this.state = r.state;
    this.launchOutcome = r.outcome;
    if (r.outcome.kind === 'swap-failed') {
      this.error = explainSwapLog(this.readSwapLog());
      this.phase = 'error';
    }
    if (r.outcome.kind !== 'normal') this.save();
    return r.outcome;
  }

  get outcome(): LaunchOutcome {
    return this.launchOutcome;
  }

  private readSwapLog(): string {
    try {
      return readFileSync(join(this.o.dataDir, 'swap.log'), 'utf8').split('\n').slice(-20).join('\n');
    } catch {
      return '';
    }
  }

  /** The freshly installed version has run for a while: forget the marker, delete the previous copy, show "what's new" once. */
  async markHealthy(): Promise<void> {
    const p = this.state.pending;
    if (!p || p.version !== this.o.version) return;
    this.state = markHealthy(this.state, this.now());
    this.launchOutcome = { kind: 'normal' };
    this.save();
    if (p.oldAppPath && isOldCopyOf(this.o.appPath, p.oldAppPath)) await rm(p.oldAppPath, { recursive: true, force: true }).catch(() => undefined);
    this.emit();
  }

  /** Removes staging folders and downloads left behind by earlier runs. Never touches anything else. */
  async cleanup(): Promise<void> {
    const keepStage = this.staged?.stageDir;
    if (this.location().ok) {
      const dir = dirname(this.o.appPath);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith(STAGE_PREFIX) && join(dir, name) !== keepStage) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    for (const name of await readdir(this.o.dataDir).catch(() => [] as string[])) {
      if (!parseSemver(name)) continue;
      const keep = this.feed && name === this.feed.version && compareSemver(name, this.o.version) > 0;
      if (!keep) await rm(join(this.o.dataDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── check / download / install ─────────────────────────────────────────

  private isBusy(): boolean {
    return this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'verifying' || this.phase === 'installing';
  }

  private set(phase: UpdatePhaseDto, error: string | null = null): void {
    this.phase = phase;
    this.error = error;
    this.emit();
  }

  async check(): Promise<UpdateStatusDto> {
    if (this.isBusy()) return this.status();
    if (this.phase === 'ready') return this.status();
    this.set('checking');
    let feed: Feed;
    try {
      feed = await fetchFeed(this.o.feed, { fetch: this.o.fetch });
    } catch (e) {
      this.state = { ...this.state, lastCheckedAt: this.now().toISOString() };
      this.save();
      if (e instanceof FeedError && e.code === 'not_published') {
        this.set('up-to-date');
      } else {
        this.set('error', (e as Error).message);
      }
      return this.status();
    }
    this.state = { ...this.state, lastCheckedAt: this.now().toISOString() };
    this.save();
    const d = decide(feed, { version: this.o.version, channel: this.channel, osVersion: this.o.osVersion, blocked: this.state.blocked });
    if (d.kind !== 'update') {
      this.feed = null;
      const why = d.kind === 'needs-newer-os' ? `OpenKT ${feed.version} needs macOS ${feed.min_os} or later.` : null;
      this.set('up-to-date', why);
      return this.status();
    }
    this.feed = d.feed;
    this.set('available');
    if (this.state.auto && this.location().ok && this.mode !== 'disabled') void this.download();
    return this.status();
  }

  async download(): Promise<UpdateStatusDto> {
    const feed = this.feed;
    if (!feed || this.isBusy() || this.phase === 'ready') return this.status();
    const loc = this.location();
    if (!loc.ok) {
      this.set('available', loc.message);
      return this.status();
    }
    const run = this.o.signed ? this.downloadSigned(feed, this.o.signed) : this.downloadCustom(feed);
    this.busy = run;
    await run.finally(() => {
      this.busy = null;
    });
    return this.status();
  }

  private async downloadSigned(feed: Feed, signed: SignedAdapter): Promise<void> {
    this.progress = { receivedBytes: 0, totalBytes: feed.files.zip.size, bytesPerSec: 0 };
    this.set('downloading');
    try {
      await signed.download(feed, (p) => {
        this.progress = p;
        this.emit();
      });
      this.set('ready');
    } catch (e) {
      this.set('error', `could not download the update: ${(e as Error).message}`);
    }
  }

  private async downloadCustom(feed: Feed): Promise<void> {
    this.progress = { receivedBytes: 0, totalBytes: feed.files.zip.size, bytesPerSec: 0 };
    this.set('downloading');
    let zip: string;
    try {
      zip = await downloadUpdate({
        feed,
        dir: this.o.dataDir,
        fetch: this.o.fetch,
        backoffMs: this.o.backoffMs,
        onProgress: (p) => {
          this.progress = p;
          this.emit();
        },
      });
    } catch (e) {
      this.set('error', e instanceof UpdateDownloadError ? e.message : `could not download the update: ${(e as Error).message}`);
      return;
    }
    this.set('verifying');
    try {
      this.staged = await this.prepare(feed, zip);
      this.set('ready');
    } catch (e) {
      // A bundle that fails verification is never retried from the same file.
      if (e instanceof BundleError) await rm(dirname(zip), { recursive: true, force: true }).catch(() => undefined);
      this.set('error', e instanceof BundleError ? `The update was rejected: ${e.message}. It was deleted and will not be installed.` : `could not prepare the update: ${(e as Error).message}`);
    }
  }

  /** Expand next to the running app (same volume, so the swap is a rename) and verify the bundle. */
  private async prepare(feed: Feed, zip: string): Promise<Staged> {
    const stageDir = join(dirname(this.o.appPath), `${STAGE_PREFIX}${feed.version}-${randomBytes(4).toString('hex')}`);
    await mkdir(stageDir, { recursive: false });
    try {
      const app = await unzipBundle(zip, stageDir, this.tools);
      await verifyBundle(app, { bundleId: this.o.bundleId, version: feed.version, teamId: this.o.teamId }, this.tools);
      await stripQuarantine(app, this.tools);
      return { version: feed.version, app, stageDir };
    } catch (e) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  async install(): Promise<UpdateStatusDto> {
    const feed = this.feed;
    if (this.phase !== 'ready' || !feed) return this.status();
    if (compareSemver(feed.version, this.o.version) <= 0) {
      this.set('error', 'refusing to install a version that is not newer');
      return this.status();
    }
    const pending = (oldAppPath: string) => {
      this.state = {
        ...this.state,
        pending: { version: feed.version, from: this.o.version, oldAppPath, installedAt: this.now().toISOString(), starts: 0 },
        pendingNotes: feed.notes,
      };
      this.save();
    };

    if (this.o.signed) {
      this.set('installing');
      pending('');
      this.o.signed.install();
      return this.status();
    }

    const staged = this.staged;
    const loc = this.location();
    if (!staged || staged.version !== feed.version || !existsSync(staged.app)) {
      this.staged = null;
      this.set('available', 'The prepared update is gone; it will download again.');
      return this.status();
    }
    if (!loc.ok) {
      this.set('ready', loc.message);
      return this.status();
    }
    this.set('installing');
    try {
      // Cheap insurance: the staged copy is re-verified right before it replaces the app.
      await verifyBundle(staged.app, { bundleId: this.o.bundleId, version: feed.version, teamId: this.o.teamId }, this.tools);
      const oldAppPath = `${loc.appPath}.old-${this.now().getTime()}`;
      pending(oldAppPath);
      await spawnSwap(
        {
          pid: this.o.pid,
          appPath: loc.appPath,
          newAppPath: staged.app,
          oldAppPath,
          stageDir: staged.stageDir,
          logPath: join(this.o.dataDir, 'swap.log'),
          openArgs: this.o.openArgs,
          tools: this.tools,
        },
        join(this.o.dataDir, 'swap.sh'),
      );
    } catch (e) {
      this.state = { ...this.state, pending: null, pendingNotes: [] };
      this.save();
      if (e instanceof BundleError) {
        this.staged = null;
        await rm(staged.stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
      this.set(e instanceof BundleError ? 'error' : 'ready', `could not install the update: ${(e as Error).message}`);
      return this.status();
    }
    this.o.quit();
    return this.status();
  }

  // ── settings / rollback ────────────────────────────────────────────────

  async setAuto(on: boolean): Promise<UpdateStatusDto> {
    this.state = { ...this.state, auto: on };
    this.save();
    this.emit();
    if (on && this.phase === 'available' && this.location().ok && this.mode !== 'disabled') void this.download();
    return this.status();
  }

  seen(): UpdateStatusDto {
    const lu = this.state.lastUpdate;
    if (lu && !lu.seen) {
      this.state = { ...this.state, lastUpdate: { ...lu, seen: true } };
      this.save();
      this.emit();
    }
    return this.status();
  }

  /** "Go back to <previous>": block this version, swap the previous copy back in, relaunch. */
  async rollback(): Promise<UpdateStatusDto> {
    const p = this.state.pending;
    const loc = this.location();
    if (this.launchOutcome.kind !== 'offer-rollback' || !p || !isOldCopyOf(this.o.appPath, p.oldAppPath) || !existsSync(p.oldAppPath)) {
      this.set(this.phase, 'There is no previous version to go back to.');
      return this.status();
    }
    if (!loc.ok) {
      this.set(this.phase, loc.message);
      return this.status();
    }
    this.state = markRolledBack(this.state);
    this.save();
    this.set('installing');
    try {
      await spawnSwap(
        {
          pid: this.o.pid,
          appPath: loc.appPath,
          newAppPath: p.oldAppPath,
          oldAppPath: `${loc.appPath}.rolledback-${this.now().getTime()}`,
          logPath: join(this.o.dataDir, 'swap.log'),
          openArgs: this.o.openArgs,
          deleteReplaced: true,
          tools: this.tools,
        },
        join(this.o.dataDir, 'rollback.sh'),
      );
    } catch (e) {
      this.set('error', `could not go back: ${(e as Error).message}`);
      return this.status();
    }
    this.o.quit();
    return this.status();
  }

  /** "Keep this version" after a rollback offer: treat it as healthy. */
  async keep(): Promise<void> {
    if (this.launchOutcome.kind === 'offer-rollback') await this.markHealthy();
  }

  /** For tests and the smoke run: resolves once a background download has settled. */
  async idle(): Promise<void> {
    while (this.busy) await this.busy.catch(() => undefined);
  }
}
