/** Which models are on disk, and fetching the ones that are not. Embeddings first (small), then the LLM, then speech, then the vision projector. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadFile, type DownloadOptions, type DownloadResult } from './downloader';
import { localName, modelUrl, type ModelFile, type ModelPlan, type ModelRole } from './manifest';

export type ModelState = 'missing' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';

export interface ModelStatus {
  role: ModelRole;
  id: string;
  file: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: ModelState;
  error?: string;
}

export interface ModelsProgress {
  role: ModelRole;
  id: string;
  file: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSec: number;
  /** Across every file in this ensure() call, 0..1. */
  overall: number;
  state: ModelState;
  error?: string;
}

export const DOWNLOAD_ORDER: readonly ModelRole[] = ['embed', 'llm', 'whisper', 'mmproj'];

export interface ModelStoreOptions {
  dir: string;
  plan: ModelPlan;
  /** Override the download (tests). */
  download?: (o: DownloadOptions) => Promise<DownloadResult>;
  baseUrl?: string;
}

const size = async (p: string) => stat(p).then((s) => s.size, () => -1);

export class ModelStore {
  private readonly errors = new Map<ModelRole, string>();
  private active: ModelRole | null = null;
  private inflight: Promise<ModelStatus[]> | null = null;
  constructor(private readonly opts: ModelStoreOptions) {}

  pathOf(role: ModelRole): string {
    return join(this.opts.dir, localName(this.opts.plan[role]));
  }

  async status(roles: readonly ModelRole[] = DOWNLOAD_ORDER): Promise<ModelStatus[]> {
    return Promise.all(
      roles.map(async (role) => {
        const m: ModelFile = this.opts.plan[role];
        const path = this.pathOf(role);
        const done = (await size(path)) === m.bytes;
        const partial = done ? m.bytes : Math.max(0, await size(`${path}.part`));
        const error = this.errors.get(role);
        const state: ModelState = done ? 'ready' : this.active === role ? 'downloading' : error ? 'error' : partial > 0 ? 'partial' : 'missing';
        return { role, id: m.id, file: localName(m), path, totalBytes: m.bytes, receivedBytes: partial, state, ...(error && !done ? { error } : {}) };
      }),
    );
  }

  /** Idempotent and single-flight: a second call while downloading joins the first. */
  ensure(onProgress?: (p: ModelsProgress) => void, roles: readonly ModelRole[] = DOWNLOAD_ORDER, signal?: AbortSignal): Promise<ModelStatus[]> {
    if (!this.inflight) {
      this.inflight = this.run(onProgress, roles, signal).finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async run(onProgress: ((p: ModelsProgress) => void) | undefined, roles: readonly ModelRole[], signal?: AbortSignal): Promise<ModelStatus[]> {
    const ordered = DOWNLOAD_ORDER.filter((r) => roles.includes(r));
    const grand = ordered.reduce((n, r) => n + this.opts.plan[r].bytes, 0);
    let before = 0;
    for (const role of ordered) {
      const m = this.opts.plan[role];
      const base = { role, id: m.id, file: localName(m), totalBytes: m.bytes };
      this.errors.delete(role);
      this.active = role;
      try {
        const offset = before;
        await (this.opts.download ?? downloadFile)({
          url: modelUrl(m, this.opts.baseUrl),
          dest: this.pathOf(role),
          bytes: m.bytes,
          sha256: m.sha256,
          signal,
          onProgress: (p) =>
            onProgress?.({ ...base, receivedBytes: p.receivedBytes, bytesPerSec: p.bytesPerSec, overall: (offset + p.receivedBytes) / grand, state: p.receivedBytes >= m.bytes ? 'ready' : 'downloading' }),
        });
        before += m.bytes;
        onProgress?.({ ...base, receivedBytes: m.bytes, bytesPerSec: 0, overall: before / grand, state: 'ready' });
      } catch (e) {
        const error = (e as Error).message;
        this.errors.set(role, error);
        this.active = null;
        onProgress?.({ ...base, receivedBytes: 0, bytesPerSec: 0, overall: before / grand, state: 'error', error });
        throw e;
      } finally {
        this.active = null;
      }
    }
    return this.status(roles);
  }
}
