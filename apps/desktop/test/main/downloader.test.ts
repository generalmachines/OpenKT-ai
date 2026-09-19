import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChecksumError, DownloadError, downloadFile } from '../../src/main/models/downloader';

const BODY = randomBytes(1_000_000);
const SHA = createHash('sha256').update(BODY).digest('hex');

let server: Server;
let base = '';
let dir = '';
/** Per-test server behaviour. */
const behaviour = { ignoreRange: false, cutAfter: 0, failFirst: 0, slowChunks: false };
const seen: { range: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range;
    seen.push({ range });
    if (behaviour.failFirst > 0) { behaviour.failFirst -= 1; res.writeHead(503).end(); return; }
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(range ?? '');
    if (m && !behaviour.ignoreRange) start = Number(m[1]);
    if (start >= BODY.length) { res.writeHead(416).end(); return; }
    const slice = BODY.subarray(start);
    res.writeHead(start > 0 ? 206 : 200, {
      'content-length': slice.length,
      ...(start > 0 ? { 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` } : {}),
    });
    if (behaviour.cutAfter > 0) {
      const n = behaviour.cutAfter;
      behaviour.cutAfter = 0;
      res.write(slice.subarray(0, n), () => res.destroy());
      return;
    }
    if (behaviour.slowChunks) {
      let i = 0;
      const step = 50_000;
      const tick = () => {
        if (res.destroyed) return;
        if (i >= slice.length) { res.end(); return; }
        res.write(slice.subarray(i, i + step));
        i += step;
        setTimeout(tick, 40);
      };
      tick();
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => {
  Object.assign(behaviour, { ignoreRange: false, cutAfter: 0, failFirst: 0, slowChunks: false });
  seen.length = 0;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'okt-dl-'));
});

describe('downloadFile', () => {
  it('downloads, verifies sha256 and renames atomically (no .part left)', async () => {
    const dest = join(dir, 'nested', 'm.gguf');
    const r = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA });
    expect(r).toMatchObject({ bytes: BODY.length, sha256: SHA, resumedFrom: 0, cached: false });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('never exposes a partial file at the final path', async () => {
    const dest = join(dir, 'm.gguf');
    behaviour.slowChunks = true;
    let sawDestEarly = false;
    await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA, progressIntervalMs: 0,
      onProgress: (p) => { if (p.receivedBytes < BODY.length && existsSync(dest)) sawDestEarly = true; } });
    expect(sawDestEarly).toBe(false);
    expect(statSync(dest).size).toBe(BODY.length);
  });

  it('resumes an aborted download with a Range request', async () => {
    const dest = join(dir, 'm.gguf');
    behaviour.slowChunks = true;
    const ac = new AbortController();
    await expect(
      downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA, signal: ac.signal, progressIntervalMs: 0,
        onProgress: (p) => { if (p.receivedBytes >= 300_000) ac.abort(); } }),
    ).rejects.toThrow();
    const partial = statSync(`${dest}.part`).size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(BODY.length);
    expect(existsSync(dest)).toBe(false);

    behaviour.slowChunks = false;
    const r = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA });
    expect(r.resumedFrom).toBe(partial);
    expect(seen.at(-1)?.range).toBe(`bytes=${partial}-`);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('resumes after the connection drops mid-body, with backoff', async () => {
    const dest = join(dir, 'm.gguf');
    behaviour.cutAfter = 400_000;
    const r = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA, backoffMs: 5 });
    expect(r.attempts).toBe(2);
    expect(r.resumedFrom).toBeGreaterThan(0);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('starts over when the server ignores Range', async () => {
    const dest = join(dir, 'm.gguf');
    writeFileSync(`${dest}.part`, Buffer.from('garbage-that-is-not-the-prefix'));
    behaviour.ignoreRange = true;
    const r = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA });
    expect(r.resumedFrom).toBe(0);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('checksum mismatch → deletes the file and throws, without retrying', async () => {
    const dest = join(dir, 'm.gguf');
    await expect(downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: 'f'.repeat(64) })).rejects.toBeInstanceOf(ChecksumError);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.length).toBe(1);
  });

  it('a corrupt partial prefix fails the checksum and is deleted, so the next run is clean', async () => {
    const dest = join(dir, 'm.gguf');
    writeFileSync(`${dest}.part`, Buffer.alloc(1000, 7));
    await expect(downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA })).rejects.toBeInstanceOf(ChecksumError);
    const r = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA });
    expect(r.sha256).toBe(SHA);
  });

  it('retries HTTP errors with backoff, then gives up with a clear error', async () => {
    const dest = join(dir, 'm.gguf');
    behaviour.failFirst = 2;
    const ok = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA, backoffMs: 5 });
    expect(ok.attempts).toBe(3);

    rmSync(dest);
    behaviour.failFirst = 99;
    await expect(downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA, backoffMs: 1, maxRetries: 2 })).rejects.toBeInstanceOf(DownloadError);
  });

  it('throttles progress to the interval and always emits a final 100% event', async () => {
    const dest = join(dir, 'm.gguf');
    behaviour.slowChunks = true; // 20 chunks × 40 ms ≈ 800 ms
    const times: number[] = [];
    let last = 0;
    await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA, progressIntervalMs: 250,
      onProgress: (p) => { times.push(Date.now()); last = p.receivedBytes; } });
    expect(last).toBe(BODY.length);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times.length).toBeLessThanOrEqual(6);
    const gaps = times.slice(1, -1).map((t, i) => t - (times[i] as number));
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(245);
  });

  it('treats a complete file on disk as cached and makes no request', async () => {
    const dest = join(dir, 'm.gguf');
    writeFileSync(dest, BODY);
    const r = await downloadFile({ url: `${base}/m`, dest, bytes: BODY.length, sha256: SHA });
    expect(r.cached).toBe(true);
    expect(seen.length).toBe(0);
  });
});
