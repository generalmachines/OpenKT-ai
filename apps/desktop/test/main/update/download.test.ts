import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { downloadUpdate, zipPathFor } from '../../../src/main/update/download';
import { parseFeed, type Feed } from '../../../src/main/update/feed';
import { startServer, type FixtureServer } from './helpers';

const BODY = randomBytes(600_000);
const SHA = createHash('sha256').update(BODY).digest('hex');
let srv: FixtureServer;
let dir = '';

function feedFor(over: { sha256?: string; size?: number; path?: string } = {}): Feed {
  return parseFeed(
    { version: '0.3.9', files: { zip: { url: `${srv.base}${over.path ?? '/releases/0.3.9/OpenKT-0.3.9-arm64.zip'}`, sha256: over.sha256 ?? SHA, size: over.size ?? BODY.length } } },
    { url: `${srv.base}/latest.json`, allowLoopbackHttp: true },
  );
}

beforeAll(async () => {
  srv = await startServer();
  srv.files.set('/releases/0.3.9/OpenKT-0.3.9-arm64.zip', BODY);
});
afterAll(() => srv.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openkt-upd-dl-'));
  srv.seen.length = 0;
  Object.assign(srv.behaviour, { cutAfter: 0, redirect: {}, status: {} });
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('downloadUpdate', () => {
  it('downloads into updates/<version>/ and verifies the sha256', async () => {
    const progress: number[] = [];
    const path = await downloadUpdate({ feed: feedFor(), dir, onProgress: (p) => progress.push(p.receivedBytes) });
    expect(path).toBe(zipPathFor(dir, '0.3.9'));
    expect(path).toBe(join(dir, '0.3.9', 'OpenKT-0.3.9-arm64.zip'));
    expect(readFileSync(path).equals(BODY)).toBe(true);
    expect(progress.at(-1)).toBe(BODY.length);
  });

  it('resumes a cut connection with a Range request', async () => {
    srv.behaviour.cutAfter = 200_000;
    const path = await downloadUpdate({ feed: feedFor(), dir, backoffMs: 1 });
    expect(readFileSync(path).equals(BODY)).toBe(true);
    const ranges = srv.seen.map((s) => s.range);
    expect(ranges[0]).toBeUndefined();
    expect(ranges.some((r) => r && /^bytes=\d+-$/.test(r) && Number(r.slice(6, -1)) >= 200_000)).toBe(true);
  });

  it('resumes a .part left by an earlier run', async () => {
    const dest = zipPathFor(dir, '0.3.9');
    mkdirSync(join(dir, '0.3.9'), { recursive: true });
    writeFileSync(`${dest}.part`, BODY.subarray(0, 100_000));
    await downloadUpdate({ feed: feedFor(), dir });
    expect(srv.seen[0]?.range).toBe('bytes=100000-');
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('deletes a file whose sha256 does not match and never returns it', async () => {
    await expect(downloadUpdate({ feed: feedFor({ sha256: 'b'.repeat(64) }), dir })).rejects.toMatchObject({ code: 'checksum_mismatch' });
    const dest = zipPathFor(dir, '0.3.9');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('re-hashes a complete file already on disk instead of trusting its size', async () => {
    const dest = zipPathFor(dir, '0.3.9');
    mkdirSync(join(dir, '0.3.9'), { recursive: true });
    writeFileSync(dest, randomBytes(BODY.length)); // right size, wrong bytes
    await expect(downloadUpdate({ feed: feedFor(), dir })).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(existsSync(dest)).toBe(false);
    expect(srv.seen).toHaveLength(0);
  });

  it('refuses to follow a redirect off the pinned host', async () => {
    srv.behaviour.redirect['/releases/0.3.9/OpenKT-0.3.9-arm64.zip'] = 'https://evil.example/OpenKT.zip';
    await expect(downloadUpdate({ feed: feedFor(), dir, backoffMs: 1 })).rejects.toMatchObject({ code: 'download_failed' });
  });

  it('refuses a server copy that is not the promised size on the first response (no retry loop)', async () => {
    await expect(downloadUpdate({ feed: feedFor({ size: BODY.length + 10 }), dir, backoffMs: 1 })).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(srv.seen).toHaveLength(1);
    expect(existsSync(zipPathFor(dir, '0.3.9'))).toBe(false);
    expect(existsSync(`${zipPathFor(dir, '0.3.9')}.part`)).toBe(false);
  });
});
