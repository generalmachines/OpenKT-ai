/**
 * Fetches the update archive into userData/updates/<version>/ with the app's resumable downloader
 * (src/main/models/downloader.ts: `.part` file, HTTP Range resume, size + sha256 check, atomic rename).
 * On top of it: redirects are refused (the feed pinned the host), and a file already on disk is
 * re-hashed before it is trusted — a checksum mismatch deletes it and fails, it is never installed.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadFile, sha256File, type DownloadProgress } from '../models/downloader';
import type { Feed } from './feed';

export class UpdateDownloadError extends Error {
  constructor(readonly code: 'checksum_mismatch' | 'download_failed', message: string) {
    super(message);
  }
}

export interface UpdateDownloadOptions {
  feed: Feed;
  /** userData/updates */
  dir: string;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  backoffMs?: number;
}

/** The full size of the resource: Content-Range's total for a 206, Content-Length for a 200. */
function totalBytes(res: Response): number | null {
  if (res.status === 206) {
    const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
    return m ? Number(m[1]) : null;
  }
  const len = res.headers.get('content-length');
  return len !== null && /^\d+$/.test(len) ? Number(len) : null;
}

export function zipPathFor(dir: string, version: string): string {
  return join(dir, version, `OpenKT-${version}-arm64.zip`);
}

export async function downloadUpdate(opts: UpdateDownloadOptions): Promise<string> {
  const { feed } = opts;
  const zip = feed.files.zip;
  const dest = zipPathFor(opts.dir, feed.version);
  const baseFetch = opts.fetch ?? fetch;
  // The shared downloader retries a short body forever (it re-requests the whole file); an update whose server
  // copy is not the size the feed promised is refused on the first response instead.
  const guard = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, guard.signal]) : guard.signal;
  const checked: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, { ...init, redirect: 'error' });
    const total = res.ok ? totalBytes(res) : null;
    if (total !== null && total !== zip.size) {
      await res.body?.cancel().catch(() => undefined);
      await rm(`${dest}.part`, { force: true });
      const err = new UpdateDownloadError('checksum_mismatch', `the server's update for ${feed.version} is ${total} bytes, the feed promised ${zip.size}; it will not be installed`);
      guard.abort(err);
      throw err;
    }
    return res;
  };
  try {
    const r = await downloadFile({
      url: zip.url,
      dest,
      bytes: zip.size,
      sha256: zip.sha256,
      onProgress: opts.onProgress,
      signal,
      fetch: checked,
      maxRetries: 3,
      backoffMs: opts.backoffMs,
    });
    // The shared downloader trusts a complete file by size alone; an update is trusted by its hash.
    if (r.cached && (await sha256File(dest)) !== zip.sha256) {
      await rm(dest, { force: true });
      throw new UpdateDownloadError('checksum_mismatch', `the downloaded update for ${feed.version} is corrupt; it was deleted`);
    }
    return dest;
  } catch (e) {
    if (e instanceof UpdateDownloadError) throw e;
    if ((e as { code?: string }).code === 'checksum_mismatch') {
      throw new UpdateDownloadError('checksum_mismatch', `the update for ${feed.version} did not match its checksum; it was deleted and will not be installed`);
    }
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new UpdateDownloadError('download_failed', `could not download the update: ${(e as Error).message}`);
  }
}
