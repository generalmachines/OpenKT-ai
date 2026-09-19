/**
 * The first-run half of the model download: one controller for the whole app (pause means
 * pause everywhere), the disk-space check, the smaller-model rule, what is bundled, and a
 * pause that keeps what arrived. Plain Node; downloads are fakes.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DownloadController, FOLLOW_ROLES, LOW_DISK, REQUIRED_ROLES } from '../../src/main/models/controller';
import type { DownloadOptions } from '../../src/main/models/downloader';
import { GIB, chooseModels, loadManifest, type ModelRole } from '../../src/main/models/manifest';
import { chosenRoles, DISK_HEADROOM_BYTES, diskCheck, freeBytes, remainingBytes, setupInfo, withChoice } from '../../src/main/models/setup';
import { DOWNLOAD_ORDER, ModelStore, type ModelsProgress, type ModelStatus } from '../../src/main/models/store';

const manifest = loadManifest();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** An ensure() the test drives: each call waits until released or aborted. */
function fakeEnsure() {
  const calls: { roles: readonly ModelRole[]; signal: AbortSignal; release: () => void; fail: (e: Error) => void }[] = [];
  const ensure = vi.fn(
    (_p: (p: ModelsProgress) => void, roles: readonly ModelRole[], signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        calls.push({ roles, signal, release: resolve, fail: reject });
      }),
  );
  return { ensure, calls };
}

describe('what people are shown before they choose', () => {
  it('every model in the manifest names its open-source model, its licence and its Hugging Face card', () => {
    for (const [id, m] of Object.entries(manifest.models)) {
      expect(m.name, id).toBeTruthy();
      expect(m.model, id).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(['Apache-2.0', 'MIT'], id).toContain(m.license);
    }
    expect(manifest.models['llm-4b']).toMatchObject({ name: 'Qwen3.5-4B', model: 'Qwen/Qwen3.5-4B', license: 'Apache-2.0' });
    expect(manifest.models['whisper-turbo']).toMatchObject({ model: 'openai/whisper-large-v3-turbo', license: 'MIT' });
  });

  it('status carries them to the screen: name, licence, the model card and where the file comes from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'okt-about-'));
    const store = new ModelStore({ dir, plan: chooseModels(manifest, 16 * GIB) });
    const [llm, whisper] = await store.status(['llm', 'whisper']);
    expect(llm).toMatchObject({ name: 'Qwen3.5-4B', license: 'Apache-2.0', card: 'https://huggingface.co/Qwen/Qwen3.5-4B', source: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF' });
    expect(whisper).toMatchObject({ name: 'Whisper large-v3-turbo', license: 'MIT', card: 'https://huggingface.co/openai/whisper-large-v3-turbo', source: 'https://huggingface.co/ggerganov/whisper.cpp' });
  });
});

describe('every model a feature needs is in the one download', () => {
  it('search, understanding, speech (the transcriber’s model) and images — nothing is fetched lazily elsewhere', () => {
    expect([...REQUIRED_ROLES, ...FOLLOW_ROLES].sort()).toEqual([...DOWNLOAD_ORDER].sort());
    const big = chooseModels(manifest, 16 * GIB);
    const small = chooseModels(manifest, 8 * GIB);
    expect(big.whisper.file).toBe('ggml-large-v3-turbo-q5_0.bin');
    expect(small.whisper.file).toBe('ggml-small.bin');
    const total = (p: typeof big) => DOWNLOAD_ORDER.reduce((n, r) => n + p[r].bytes, 0);
    // what the first-run screen says up front
    expect(total(big) / 1e9).toBeCloseTo(4.63, 1);
    expect(total(small) / 1e9).toBeCloseTo(3.08, 1);
  });
});

describe('DownloadController', () => {
  const started = (calls: { roles: readonly ModelRole[] }[]) => calls.map((c) => c.roles.join(','));
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await tick();
  };

  it('nothing is fetched until asked; a full download goes one file at a time and resolves once search + understanding are there', async () => {
    const { ensure, calls } = fakeEnsure();
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async () => true });
    await settle();
    expect(ensure).not.toHaveBeenCalled();
    let resolved = false;
    const all = c.start().then((r) => ((resolved = true), r));
    await settle();
    expect(started(calls)).toEqual(['embed']);
    calls[0]!.release();
    await settle();
    expect(started(calls)).toEqual(['embed', 'llm']);
    expect(resolved).toBe(false);
    calls[1]!.release();
    expect(await all).toEqual({ ok: true });
    await settle();
    expect(started(calls)).toEqual(['embed', 'llm', 'whisper']);
    calls[2]!.release();
    await settle();
    calls[3]!.release();
    await settle();
    expect(started(calls)).toEqual(['embed', 'llm', 'whisper', 'mmproj']);
    expect(c.running).toBe(false);
    expect(c.queued).toEqual([]);
  });

  it('a feature asking for its model (voice → speech) gets just that, and it resolves when that file is on disk', async () => {
    const { ensure, calls } = fakeEnsure();
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async () => true });
    const speech = c.start({ roles: ['whisper'] });
    await settle();
    expect(started(calls)).toEqual(['whisper']);
    calls[0]!.release();
    expect(await speech).toEqual({ ok: true });
    await settle();
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('asked for while everything downloads, a feature’s model goes next (after the file in flight)', async () => {
    const { ensure, calls } = fakeEnsure();
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async () => true });
    void c.start();
    await settle();
    const speech = c.start({ roles: ['whisper'] });
    expect(c.queued).toEqual(['whisper', 'embed', 'llm', 'mmproj']);
    calls[0]!.release(); // embed, already in flight, finishes first
    await settle();
    expect(started(calls)).toEqual(['embed', 'whisper']);
    calls[1]!.release();
    expect(await speech).toEqual({ ok: true });
  });

  it('a second start joins the run in flight — never a second download of the same file', async () => {
    const { ensure, calls } = fakeEnsure();
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async () => true });
    const a = c.start({ auto: true, roles: ['embed', 'llm', 'whisper', 'mmproj'] });
    const b = c.start();
    await settle();
    for (let i = 0; i < 4; i += 1) {
      calls[i]!.release();
      await settle();
    }
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(started(calls)).toEqual(['embed', 'llm', 'whisper', 'mmproj']);
  });

  it('does not start when the disk cannot hold what was asked for, and says why', async () => {
    const { ensure } = fakeEnsure();
    const asked: (readonly ModelRole[])[] = [];
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async (roles) => (asked.push(roles), false) });
    expect(await c.start({ roles: ['whisper'] })).toEqual({ ok: false, error: LOW_DISK });
    expect(asked).toEqual([['whisper']]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('pause stops the transfer and reads as paused (not failed); a later launch never overrides it; resume continues the same models', async () => {
    const { ensure, calls } = fakeEnsure();
    const log = vi.fn();
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async () => true, log });
    const run = c.start({ roles: ['whisper'] });
    await settle();
    c.pause();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(await run).toEqual({ ok: false, error: 'paused' });
    expect(c.paused).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(await c.start({ auto: true, roles: ['whisper'] })).toEqual({ ok: false, error: 'paused' });

    const again = c.resume();
    expect(c.paused).toBe(false);
    await settle();
    expect(started(calls)).toEqual(['whisper', 'whisper']); // the speech model again — not everything
    calls[1]!.release();
    expect(await again).toEqual({ ok: true });
  });

  it('a failure is reported with its message and logged; the file stays first in line, so Retry (resume) continues it', async () => {
    const { ensure, calls } = fakeEnsure();
    const log = vi.fn();
    const c = new DownloadController({ ensure, emit: () => undefined, enoughDisk: async () => true, log });
    const run = c.start();
    await settle();
    calls[0]!.fail(new Error('gave up after 5 attempts'));
    expect(await run).toEqual({ ok: false, error: 'gave up after 5 attempts' });
    expect(log).toHaveBeenCalledWith('[models] download failed: gave up after 5 attempts');
    expect(c.queued).toEqual(['embed', 'llm', 'whisper', 'mmproj']);
    const retry = c.resume();
    await settle();
    expect(started(calls)).toEqual(['embed', 'embed']);
    for (let i = 1; i < 5; i += 1) {
      calls[i]!.release();
      await settle();
    }
    expect(await retry).toEqual({ ok: true });
  });
});

describe('the choice is remembered', () => {
  it('reads the saved choice defensively and adds new choices to it', () => {
    expect(chosenRoles(null)).toEqual([]);
    expect(chosenRoles({ roles: ['whisper', 'nope', 7] })).toEqual(['whisper']);
    expect(withChoice(['whisper'], ['embed', 'llm', 'whisper', 'mmproj'])).toEqual(['embed', 'llm', 'whisper', 'mmproj']);
    expect(withChoice([], ['whisper'])).toEqual(['whisper']);
  });
});

describe('ModelStore pause', () => {
  it('an aborted download is paused, not an error: the .part stays and status reads partial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'okt-pause-'));
    const plan = chooseModels(manifest, 8 * GIB);
    const abort = new AbortController();
    const download = async (o: DownloadOptions) => {
      writeFileSync(`${o.dest}.part`, Buffer.alloc(1234));
      abort.abort(new DOMException('paused', 'AbortError'));
      throw o.signal!.reason as Error;
    };
    const store = new ModelStore({ dir, plan, download });
    const events: ModelsProgress[] = [];
    await expect(store.ensure((p) => events.push(p), ['embed'], abort.signal)).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ role: 'embed', state: 'partial', receivedBytes: 1234 });
    const [embed] = await store.status(['embed']);
    expect(embed).toMatchObject({ state: 'partial', receivedBytes: 1234 });
    expect(embed!.error).toBeUndefined();
  });
});

describe('setup facts', () => {
  const row = (role: ModelRole, total: number, received: number, state: ModelStatus['state']): ModelStatus => ({ role, id: role, file: `${role}.gguf`, path: '', totalBytes: total, receivedBytes: received, state });

  it('remaining bytes count only what is not on disk yet', () => {
    expect(remainingBytes([row('embed', 100, 100, 'ready'), row('llm', 1000, 250, 'partial'), row('whisper', 500, 0, 'missing')])).toBe(1250);
  });

  it('the disk check keeps 1 GB of headroom; unknown free space is not treated as low', () => {
    expect(diskCheck(10 * GIB, 4 * GIB)).toEqual({ neededBytes: 4 * GIB + DISK_HEADROOM_BYTES, enoughDisk: true });
    expect(diskCheck(4.5 * GIB, 4 * GIB).enoughDisk).toBe(false);
    expect(diskCheck(null, 4 * GIB).enoughDisk).toBe(true);
    expect(diskCheck(0, 0)).toEqual({ neededBytes: 0, enoughDisk: true });
  });

  it('free space is read from the nearest folder that exists (the models folder may not yet)', async () => {
    const seen: string[] = [];
    const stat = async (p: string) => {
      seen.push(p);
      if (p !== '/Users/ana/Library') throw new Error('ENOENT');
      return { bavail: 1000n, bsize: 4096n };
    };
    expect(await freeBytes('/Users/ana/Library/Application Support/OpenKT/models', stat)).toBe(4_096_000);
    expect(seen[0]).toBe('/Users/ana/Library/Application Support/OpenKT/models');
    expect(await freeBytes('/nowhere', async () => Promise.reject(new Error('ENOENT')))).toBeNull();
  });

  it('an 8 GB Mac is told it gets the smaller model; bundled helpers are checked on disk', async () => {
    const models = [row('embed', 600, 600, 'ready'), row('llm', 1300, 0, 'missing')];
    const exists = (p: string) => p !== '/app/ocr/openkt-ocr';
    const binaries = { runtime: '/app/llama/llama-server', transcriber: '/app/whisper/whisper-cli', textReader: '/app/ocr/openkt-ocr' };
    const eight = await setupInfo({ models, modelsDir: '/m', totalMemBytes: 8 * GIB, paused: false, binaries, exists, stat: async () => ({ bavail: 1, bsize: 1 }) });
    expect(eight).toMatchObject({ totalBytes: 1900, remainingBytes: 1300, smallModel: true, enoughDisk: false, freeBytes: 1, bundled: { runtime: true, transcriber: true, textReader: false } });
    const sixteen = await setupInfo({ models, modelsDir: '/m', totalMemBytes: 16 * GIB, paused: true, binaries, exists, stat: async () => ({ bavail: 10 * GIB, bsize: 1 }) });
    expect(sixteen).toMatchObject({ smallModel: false, paused: true, enoughDisk: true });
  });
});
