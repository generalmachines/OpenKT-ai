/**
 * Can this running copy replace itself? Only when it is a real installed bundle on a writable volume.
 * A copy running straight from the disk image (/Volumes/…), an App-Translocated copy (macOS runs
 * quarantined apps from a read-only random path) or a copy on a read-only volume is told to move to
 * Applications first.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LocationReason = 'not_packaged' | 'unsupported_platform' | 'dmg' | 'translocated' | 'read_only' | 'not_writable' | 'not_a_bundle';

export type LocationAssessment =
  | { ok: true; appPath: string; dir: string }
  | { ok: false; reason: LocationReason; message: string; /** `Move to Applications` can fix it. */ canMove: boolean };

export interface LocationInput {
  /** The `.app` bundle path (app.getPath('exe') → …/Contents/MacOS/x → three levels up). */
  appPath: string;
  platform: NodeJS.Platform;
  packaged: boolean;
  /** Injected in tests. */
  fs?: { accessSync: typeof accessSync; statSync: typeof statSync };
}

/** …/OpenKT.app/Contents/MacOS/OpenKT → …/OpenKT.app */
export function bundlePathFromExe(exe: string): string {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
  return m?.[1] ?? exe;
}

const isRoFs = (e: unknown) => (e as { code?: string })?.code === 'EROFS';

export function assessLocation(input: LocationInput): LocationAssessment {
  const fs = input.fs ?? { accessSync, statSync };
  const appPath = input.appPath;
  if (input.platform !== 'darwin') return { ok: false, reason: 'unsupported_platform', message: 'In-app updates are only available on macOS.', canMove: false };
  if (!input.packaged) return { ok: false, reason: 'not_packaged', message: 'This is a development build; it updates from source.', canMove: false };
  if (!appPath.endsWith('.app')) return { ok: false, reason: 'not_a_bundle', message: `OpenKT is not running from an app bundle (${appPath}).`, canMove: false };
  if (appPath.startsWith('/Volumes/')) {
    return { ok: false, reason: 'dmg', message: 'OpenKT is running from the disk image. Drag it to Applications first — then it can update itself.', canMove: true };
  }
  if (appPath.includes('/AppTranslocation/')) {
    return { ok: false, reason: 'translocated', message: 'macOS is running OpenKT from a temporary read-only copy. Move it to Applications first — then it can update itself.', canMove: true };
  }
  const dir = dirname(appPath);
  for (const p of [appPath, dir]) {
    try {
      fs.statSync(p);
      fs.accessSync(p, constants.W_OK);
    } catch (e) {
      if (isRoFs(e)) return { ok: false, reason: 'read_only', message: `OpenKT is on a read-only volume (${dir}). Move it to Applications first.`, canMove: true };
      return { ok: false, reason: 'not_writable', message: `OpenKT cannot write to ${p === dir ? dir : 'its own bundle'}. Move it to a folder you own (Applications), or fix its permissions, then check again.`, canMove: true };
    }
  }
  return { ok: true, appPath, dir };
}
