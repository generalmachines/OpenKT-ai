import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DownloadOptions } from '../../src/main/models/downloader';
import { GIB, chooseModels, chooseTier, loadManifest, localName, modelUrl } from '../../src/main/models/manifest';
import { ModelStore, type ModelsProgress } from '../../src/main/models/store';

const manifest = loadManifest();

describe('RAM-based model choice', () => {
  it('≤ 8 GB Macs get the 2B model, everything else the 4B', () => {
    expect(chooseTier(8 * GIB)).toBe('2b');
    expect(chooseTier(4 * GIB)).toBe('2b');
    expect(chooseTier(16 * GIB)).toBe('4b');
    expect(chooseTier(12 * GIB)).toBe('4b');
    expect(chooseModels(manifest, 8 * GIB).llm.file).toBe('Qwen3.5-2B-Q4_K_M.gguf');
    expect(chooseModels(manifest, 24 * GIB).llm.file).toBe('Qwen3.5-4B-Q4_K_M.gguf');
    expect(chooseModels(manifest, 64 * GIB, '2b').llm.id).toBe('llm-2b');
    expect(chooseModels(manifest, 16 * GIB).whisper.file).toBe('ggml-large-v3-turbo-q5_0.bin');
    expect(chooseModels(manifest, 8 * GIB).whisper.file).toBe('ggml-small.bin');
    expect(chooseModels(manifest, 16 * GIB, undefined, 'base').whisper.file).toBe('ggml-base.bin');
    expect(manifest.whisper.tag).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('the manifest pins repo, revision, size and sha256 for every file', () => {
    for (const [id, m] of Object.entries(manifest.models)) {
      expect(m.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(m.revision, id).toMatch(/^[0-9a-f]{40}$/);
      expect(m.bytes, id).toBeGreaterThan(100_000_000);
    }
    expect(manifest.llama.sha256).toMatch(/^[0-9a-f]{64}$/);
    const plan = chooseModels(manifest, 16 * GIB);
    expect(plan.embed.file).toBe('Qwen3-Embedding-0.6B-Q8_0.gguf');
    expect(modelUrl(plan.embed)).toBe(`https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/${plan.embed.revision}/Qwen3-Embedding-0.6B-Q8_0.gguf`);
    // both mmproj files share an upstream name; they must not collide on disk
    expect(localName(chooseModels(manifest, 8 * GIB).mmproj)).not.toBe(localName(plan.mmproj));
  });
});

describe('ModelStore', () => {
  const plan = chooseModels(manifest, 8 * GIB);

  it('downloads embeddings first, then the LLM, reports overall progress, and is single-flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'okt-store-'));
    const calls: string[] = [];
    const download = async (o: DownloadOptions) => {
      calls.push(o.dest);
      o.onProgress?.({ receivedBytes: o.bytes / 2, totalBytes: o.bytes, bytesPerSec: 1 });
      await new Promise((r) => setTimeout(r, 10));
      return { path: o.dest, bytes: o.bytes, sha256: o.sha256 ?? null, resumedFrom: 0, cached: false, attempts: 1 };
    };
    const store = new ModelStore({ dir, plan, download });
    const events: ModelsProgress[] = [];
    const a = store.ensure((p) => events.push(p), ['llm', 'embed']);
    const b = store.ensure();
    expect(a).toBe(b);
    await a;
    expect(calls).toEqual([store.pathOf('embed'), store.pathOf('llm')]);
    expect(events.map((e) => e.role)).toEqual(['embed', 'embed', 'llm', 'llm']);
    expect(events.at(-1)?.overall).toBe(1);
    for (let i = 1; i < events.length; i++) expect(events[i]!.overall).toBeGreaterThanOrEqual(events[i - 1]!.overall);
  });

  it('status: missing → partial → error, with the message kept for the UI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'okt-store-'));
    const store = new ModelStore({ dir, plan, download: async () => { throw new Error('gave up after 6 attempts: HTTP 503'); } });
    expect((await store.status()).map((s) => s.state)).toEqual(['missing', 'missing', 'missing', 'missing']);
    writeFileSync(`${store.pathOf('llm')}.part`, 'abc');
    expect((await store.status(['llm']))[0]).toMatchObject({ state: 'partial', receivedBytes: 3 });
    const events: ModelsProgress[] = [];
    await expect(store.ensure((p) => events.push(p), ['embed'])).rejects.toThrow('HTTP 503');
    expect(events.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('HTTP 503') });
    expect((await store.status(['embed']))[0]).toMatchObject({ state: 'error', error: expect.stringContaining('HTTP 503') });
  });
});
