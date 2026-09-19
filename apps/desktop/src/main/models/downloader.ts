/**
 * Resumable, verified file download. Writes to `<dest>.part`, resumes with an
 * HTTP Range request, verifies size + sha256, then renames atomically.
 * A checksum mismatch deletes the partial file and fails — it is never retried silently.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  /** Bytes per second over the last reporting window. */
  bytesPerSec: number;
}

export interface DownloadOptions {
  url: string;
  dest: string;
  /** Expected size. Required: it is how a complete file is told from a partial one. */
  bytes: number;
  /** Expected sha256 (hex). When absent only the size is verified. */
  sha256?: string;
  onProgress?: (p: DownloadProgress) => void;
  /** Minimum gap between progress events. Default 250 ms (≤ 4/s). */
  progressIntervalMs?: number;
  signal?: AbortSignal;
  /** Network retries before giving up. Default 5; the counter resets whenever bytes arrive. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry, capped at 30 s. Default 1000. */
  backoffMs?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string | null;
  /** Offset the final successful request started from (> 0 means it resumed). */
  resumedFrom: number;
  /** True when the file was already complete on disk. */
  cached: boolean;
  attempts: number;
}

export class ChecksumError extends Error {
  readonly code = 'checksum_mismatch';
}
export class DownloadError extends Error {
  readonly code = 'download_failed';
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (e as { name?: string })?.name === 'AbortError';
}

export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const { url, dest, bytes, sha256, signal } = opts;
  const part = `${dest}.part`;
  const interval = opts.progressIntervalMs ?? 250;
  const maxRetries = opts.maxRetries ?? 5;
  const doFetch = opts.fetch ?? fetch;
  await mkdir(dirname(dest), { recursive: true });

  if ((await sizeOf(dest)) === bytes) {
    return { path: dest, bytes, sha256: null, resumedFrom: 0, cached: true, attempts: 0 };
  }
  await rm(dest, { force: true });

  let lastEmit = 0;
  let windowStart = Date.now();
  let windowBytes = 0;
  const emit = (received: number, force = false) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < interval) return;
    const dt = Math.max(1, now - windowStart) / 1000;
    opts.onProgress({ receivedBytes: received, totalBytes: bytes, bytesPerSec: Math.round(windowBytes / dt) });
    lastEmit = now;
    windowStart = now;
    windowBytes = 0;
  };

  let attempts = 0;
  let failures = 0;
  let resumedFrom = 0;
  for (;;) {
    signal?.throwIfAborted();
    let offset = await sizeOf(part);
    if (offset > bytes) { await rm(part, { force: true }); offset = -1; }
    if (offset < 0) offset = 0;
    if (offset === bytes) break;

    attempts += 1;
    let advanced = false;
    try {
      const res = await doFetch(url, {
        headers: { ...opts.headers, ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) },
        redirect: 'follow',
        signal,
      });
      if (res.status === 416) {
        await rm(part, { force: true });
        throw new DownloadError(`server rejected range ${offset}- for ${url}`);
      }
      if (!res.ok || !res.body) throw new DownloadError(`HTTP ${res.status} for ${url}`);
      // A 200 to a Range request means the server ignored it: start over.
      const append = res.status === 206 && offset > 0;
      if (!append) offset = 0;
      resumedFrom = offset;
      const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
      let received = offset;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
          received += chunk.byteLength;
          windowBytes += chunk.byteLength;
          advanced = true;
          emit(received);
        }
      } finally {
        await new Promise<void>((r) => out.end(r));
      }
      if (received < bytes) throw new DownloadError(`connection closed at ${received}/${bytes} bytes`);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      failures = advanced ? 1 : failures + 1;
      if (failures > maxRetries) {
        throw new DownloadError(`gave up on ${url} after ${attempts} attempts: ${(e as Error).message}`);
      }
      await sleep(Math.min(30_000, (opts.backoffMs ?? 1000) * 2 ** (failures - 1)), signal);
    }
  }

  const size = await sizeOf(part);
  const digest = sha256 ? await sha256File(part) : null;
  if (size !== bytes || (sha256 && digest !== sha256.toLowerCase())) {
    await rm(part, { force: true });
    throw new ChecksumError(
      size !== bytes ? `size mismatch for ${url}: got ${size}, expected ${bytes}` : `sha256 mismatch for ${url}: got ${digest}, expected ${sha256}`,
    );
  }
  await rename(part, dest);
  emit(bytes, true);
  return { path: dest, bytes, sha256: digest, resumedFrom, cached: false, attempts };
}
