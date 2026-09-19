/**
 * The renderer's only view of the Electron bridge. Everything here degrades:
 * in a browser (vite dev, the screenshot run, tests) `window.openkt` is
 * absent, and an older main process may lack the models / local-AI halves.
 * Callers ask `available()` first or accept a null result — they never touch
 * `window.openkt` directly.
 *
 * Wire shapes: `ModelStatusDto`, `ModelsProgressDto`, `ExtractedNoteDto` in
 * src/shared/ipc.ts (see src/main/models/README.md). Parsed defensively so a
 * drift in main degrades to "not available" instead of a crash.
 */
import type { NetRequest, NetResponse } from '../shared/ipc';

export interface ModelStatus {
  /** Stable id from the manifest, e.g. "qwen3-embedding-0.6b". */
  id: string;
  /** What it is for, in the app's words. */
  job: string;
  file?: string;
  state: 'missing' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';
  /** 0–100, from received/total bytes. */
  progress: number;
  bytesTotal?: number;
  bytesDone?: number;
  error?: string;
}

export interface ExtractedFact {
  statement: string;
  kind: string;
  quote?: string;
}

export interface ExtractedNote {
  title: string;
  summary: string;
  facts: ExtractedFact[];
}

interface LooseBridge {
  net?: { request(req: NetRequest): Promise<NetResponse> };
  secureStore?: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> };
  models?: { status?(): Promise<unknown>; ensure?(): Promise<unknown>; onProgress?(listener: (p: unknown) => void): () => void };
  localAi?: { extractNote?(input: { text: string; source?: string }): Promise<unknown> };
}

const bridge = (): LooseBridge | undefined => (typeof window === 'undefined' ? undefined : (window.openkt as LooseBridge | undefined));

const STATES = new Set<ModelStatus['state']>(['missing', 'partial', 'downloading', 'verifying', 'ready', 'error']);
const JOBS: Record<string, string> = { embed: 'Search', llm: 'Understanding', mmproj: 'Images' };
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Accepts both `ModelStatusDto` and `ModelsProgressDto`: same keys where it matters. */
function toStatus(v: unknown): ModelStatus | null {
  if (!v || typeof v !== 'object') return null;
  const j = v as Record<string, unknown>;
  const id = typeof j['id'] === 'string' ? j['id'] : '';
  if (!id) return null;
  const state = STATES.has(j['state'] as ModelStatus['state']) ? (j['state'] as ModelStatus['state']) : 'missing';
  const bytesTotal = num(j['totalBytes']);
  const bytesDone = num(j['receivedBytes']);
  const role = typeof j['role'] === 'string' ? j['role'] : '';
  return {
    id,
    job: JOBS[role] ?? (role || 'Model'),
    file: typeof j['file'] === 'string' ? j['file'] : undefined,
    state,
    progress: state === 'ready' ? 100 : bytesTotal && bytesDone !== undefined ? Math.max(0, Math.min(100, Math.floor((bytesDone / bytesTotal) * 100))) : 0,
    bytesTotal,
    bytesDone,
    error: typeof j['error'] === 'string' ? j['error'] : undefined,
  };
}

function toStatusList(v: unknown): ModelStatus[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { models?: unknown }).models) ? (v as { models: unknown[] }).models : [];
  return list.map(toStatus).filter((m): m is ModelStatus => m !== null);
}

export const models = {
  available: (): boolean => typeof bridge()?.models?.status === 'function',
  /** null when there is no model IPC (browser, older main) or it failed. */
  async status(): Promise<ModelStatus[] | null> {
    const m = bridge()?.models;
    if (typeof m?.status !== 'function') return null;
    try {
      return toStatusList(await m.status());
    } catch {
      return null;
    }
  },
  /** Downloads whatever is missing. Resolves with an error message, or null when everything is on disk. */
  async ensure(): Promise<string | null> {
    try {
      const r = (await bridge()?.models?.ensure?.()) as { ok?: boolean; error?: string } | undefined;
      return r && r.ok === false ? (r.error ?? 'download failed') : null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  onProgress(listener: (m: ModelStatus) => void): () => void {
    const m = bridge()?.models;
    if (typeof m?.onProgress !== 'function') return () => undefined;
    return m.onProgress((p) => {
      const s = toStatus(p);
      if (s) listener(s);
    });
  },
};

export const localAi = {
  available: (): boolean => typeof bridge()?.localAi?.extractNote === 'function',
  /** null when local AI is absent, not ready, has nothing to say, or fails — the caller saves the note as written. */
  async extractNote(text: string): Promise<ExtractedNote | null> {
    const ai = bridge()?.localAi;
    if (typeof ai?.extractNote !== 'function') return null;
    try {
      const r = (await ai.extractNote({ text, source: 'note' })) as { title?: unknown; summary?: unknown; facts?: unknown; status?: unknown } | null;
      if (!r || typeof r !== 'object' || r.status === 'noop') return null;
      const facts = (Array.isArray(r.facts) ? r.facts : [])
        .map((f): ExtractedFact | null => {
          if (typeof f === 'string') return { statement: f, kind: 'fact' };
          const o = f as { statement?: unknown; kind?: unknown; quote?: unknown } | null;
          if (!o || typeof o.statement !== 'string') return null;
          return { statement: o.statement, kind: typeof o.kind === 'string' ? o.kind : 'fact', quote: typeof o.quote === 'string' ? o.quote : undefined };
        })
        .filter((f): f is ExtractedFact => f !== null && f.statement.trim().length > 0);
      return { title: typeof r.title === 'string' ? r.title : '', summary: typeof r.summary === 'string' ? r.summary : '', facts };
    } catch {
      return null;
    }
  },
};

export const secureStore = {
  available: (): boolean => typeof bridge()?.secureStore?.get === 'function',
  get: async (key: string): Promise<string | null> => (await bridge()?.secureStore?.get(key)) ?? null,
  set: async (key: string, value: string): Promise<void> => void (await bridge()?.secureStore?.set(key, value)),
  delete: async (key: string): Promise<void> => void (await bridge()?.secureStore?.delete(key)),
};

/** Main-process request when packaged (no CORS); null in a browser. */
export const netRequest = (): ((req: NetRequest) => Promise<NetResponse>) | null => {
  const net = bridge()?.net;
  return typeof net?.request === 'function' ? (req) => net.request(req) : null;
};
