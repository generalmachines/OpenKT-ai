/**
 * Developer ID builds update through electron-updater (Squirrel.Mac), which only accepts an update whose
 * code signature matches the running app's designated requirement. It reads the SAME feed as the custom
 * updater through a small custom provider: latest.json → electron-updater's UpdateInfo (the release job
 * writes a base64 sha512 next to the sha256 for this).
 *
 * electron-updater is bundled by scripts/bundle-updater.mjs into dist-electron/vendor/electron-updater.cjs and
 * only `require`d here, on signed builds — ad-hoc builds never load it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFeed, type Feed, type FeedConfig } from './feed';
import type { SignedAdapter } from './updater';

export interface UpdateInfoLike {
  version: string;
  files: { url: string; sha512: string; size: number }[];
  path: string;
  sha512: string;
  releaseDate: string;
  releaseNotes: string;
  minimumSystemVersion?: string;
}

/** latest.json → electron-updater's UpdateInfo. Throws when the release carries no sha512. */
export function toUpdateInfo(feed: Feed): UpdateInfoLike {
  const zip = feed.files.zip;
  if (!zip.sha512) throw new Error(`release ${feed.version} has no sha512 for the archive; signed builds need it`);
  return {
    version: feed.version,
    files: [{ url: zip.url, sha512: zip.sha512, size: zip.size }],
    path: zip.url,
    sha512: zip.sha512,
    releaseDate: feed.released_at,
    releaseNotes: feed.notes.join('\n'),
  };
}

interface ElectronUpdaterModule {
  Provider: new (runtime: unknown) => object;
  MacUpdater: new (options: unknown) => MacUpdaterLike;
}

interface MacUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  updateConfigPath: string;
  logger: unknown;
  on(event: 'download-progress', listener: (p: { transferred: number; total: number; bytesPerSecond: number }) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export function createSignedAdapter(opts: { vendorPath: string; feed: FeedConfig; cacheDir: string; log?: (msg: string) => void }): SignedAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const eu = require(opts.vendorPath) as ElectronUpdaterModule;
  const feedConfig = opts.feed;

  class FeedProvider extends eu.Provider {
    constructor(_options: unknown, _updater: unknown, runtime: Record<string, unknown>) {
      super({ ...runtime, isUseMultipleRangeRequest: false });
    }
    async getLatestVersion(): Promise<UpdateInfoLike> {
      return toUpdateInfo(await fetchFeed(feedConfig));
    }
    resolveFiles(info: UpdateInfoLike): { url: URL; info: UpdateInfoLike['files'][number] }[] {
      return info.files.map((f) => ({ url: new URL(f.url), info: f }));
    }
  }

  // No app-update.yml is packaged (publish: never); electron-updater only needs its cache folder name from it.
  mkdirSync(opts.cacheDir, { recursive: true });
  const configPath = join(opts.cacheDir, 'app-update.yml');
  writeFileSync(configPath, 'provider: custom\nupdaterCacheDirName: openkt-updater\n');

  const updater = new eu.MacUpdater({ provider: 'custom', updateProvider: FeedProvider });
  updater.updateConfigPath = configPath;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  const log = opts.log ?? (() => undefined);
  updater.logger = { info: log, warn: log, error: log, debug: log };

  let onProgress: ((p: { receivedBytes: number; totalBytes: number; bytesPerSec: number }) => void) | null = null;
  updater.on('download-progress', (p) => onProgress?.({ receivedBytes: p.transferred, totalBytes: p.total, bytesPerSec: Math.round(p.bytesPerSecond) }));

  return {
    async download(feed, progress) {
      onProgress = progress;
      try {
        const r = await updater.checkForUpdates();
        if (!r?.isUpdateAvailable || r.updateInfo?.version !== feed.version) throw new Error(`electron-updater did not offer ${feed.version}`);
        await updater.downloadUpdate();
      } finally {
        onProgress = null;
      }
    },
    install() {
      updater.quitAndInstall(false, true);
    },
  };
}
