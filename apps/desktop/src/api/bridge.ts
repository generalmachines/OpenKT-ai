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
  voice?: {
    begin?(): Promise<unknown>;
    chunk?(id: string, pcm16: ArrayBuffer): unknown;
    end?(id: string, opts?: { language?: string }): Promise<unknown>;
    toSession?(id: string): Promise<unknown>;
    cancel?(id: string): unknown;
  };
  screenshot?: {
    capture?(opts: { mode: 'interactive' | 'file'; path?: string }): Promise<unknown>;
    pathForFile?(file: File): string;
  };
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

function toFacts(v: unknown): ExtractedFact[] {
  return (Array.isArray(v) ? v : [])
    .map((f): ExtractedFact | null => {
      if (typeof f === 'string') return { statement: f, kind: 'fact' };
      const o = f as { statement?: unknown; kind?: unknown; quote?: unknown } | null;
      if (!o || typeof o.statement !== 'string') return null;
      return { statement: o.statement, kind: typeof o.kind === 'string' ? o.kind : 'fact', quote: typeof o.quote === 'string' ? o.quote : undefined };
    })
    .filter((f): f is ExtractedFact => f !== null && f.statement.trim().length > 0);
}

function toNote(v: unknown): ExtractedNote | null {
  const r = v as { title?: unknown; summary?: unknown; facts?: unknown; status?: unknown } | null;
  if (!r || typeof r !== 'object' || r.status === 'noop') return null;
  return { title: typeof r.title === 'string' ? r.title : '', summary: typeof r.summary === 'string' ? r.summary : '', facts: toFacts(r.facts) };
}

export const localAi = {
  available: (): boolean => typeof bridge()?.localAi?.extractNote === 'function',
  /** null when local AI is absent, not ready, has nothing to say, or fails — the caller saves the note as written. */
  async extractNote(text: string): Promise<ExtractedNote | null> {
    const ai = bridge()?.localAi;
    if (typeof ai?.extractNote !== 'function') return null;
    try {
      return toNote(await ai.extractNote({ text, source: 'note' }));
    } catch {
      return null;
    }
  },
};

/** Thrown by the capture wrappers. `permission` = macOS refused the microphone or screen recording. */
export class CaptureError extends Error {
  constructor(
    readonly kind: 'permission' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

function captureError(e: unknown): CaptureError {
  const j = (e ?? {}) as { code?: unknown; kind?: unknown; name?: unknown; message?: unknown };
  const message = typeof j.message === 'string' ? j.message : String(e);
  // Errors cross the IPC boundary as plain messages, so the word is the only reliable signal.
  const permission = [j.code, j.kind, j.name, message].some((v) => typeof v === 'string' && /permission|not.?allowed|denied/i.test(v));
  return new CaptureError(permission ? 'permission' : 'failed', message);
}

export type VoiceResult = { empty: true } | { empty: false; text: string; durationMs: number; language: string };

/** Transcription on this Mac (whisper, not streaming: text arrives once, after `end`). */
export const voice = {
  available: (): boolean => typeof bridge()?.voice?.begin === 'function' && typeof bridge()?.voice?.end === 'function',
  async begin(): Promise<string> {
    try {
      const r = await bridge()?.voice?.begin?.();
      const id = typeof r === 'string' ? r : r && typeof r === 'object' ? (r as { id?: unknown; error?: unknown }) : null;
      if (typeof id === 'string' && id) return id;
      if (id && typeof id === 'object' && typeof id.id === 'string') return id.id;
      throw captureError(id && typeof id === 'object' ? { message: String(id.error ?? 'voice.begin returned no id'), code: id.error } : { message: 'voice.begin returned no id' });
    } catch (e) {
      throw e instanceof CaptureError ? e : captureError(e);
    }
  },
  /** Fire and forget: a dropped chunk must not stop the recording. */
  chunk(id: string, pcm16: ArrayBuffer): void {
    try {
      void Promise.resolve(bridge()?.voice?.chunk?.(id, pcm16)).catch(() => undefined);
    } catch {
      /* keep recording */
    }
  },
  async end(id: string): Promise<VoiceResult> {
    try {
      const r = (await bridge()?.voice?.end?.(id, { language: 'auto' })) as { empty?: unknown; text?: unknown; duration_ms?: unknown; language?: unknown; error?: unknown } | null;
      if (r && typeof r === 'object' && typeof r.error === 'string') throw captureError({ message: r.error, code: r.error });
      const text = r && typeof r.text === 'string' ? r.text.trim() : '';
      if (!r || r.empty === true || !text) return { empty: true };
      return { empty: false, text, durationMs: num(r.duration_ms) ?? 0, language: typeof r.language === 'string' ? r.language : 'auto' };
    } catch (e) {
      throw e instanceof CaptureError ? e : captureError(e);
    }
  },
  /** null when extraction is unavailable or fails; the transcript is still saved. */
  async toSession(id: string): Promise<ExtractedNote | null> {
    try {
      return toNote(await bridge()?.voice?.toSession?.(id));
    } catch {
      return null;
    }
  },
  cancel(id: string): void {
    try {
      void Promise.resolve(bridge()?.voice?.cancel?.(id)).catch(() => undefined);
    } catch {
      /* nothing to clean up */
    }
  },
};

export type ScreenshotResult =
  | { outcome: 'cancelled' }
  | { outcome: 'nothing' }
  | { outcome: 'captured'; imagePath: string; title: string; description: string; visibleText: string; entities: string[]; facts: ExtractedFact[] };

export const screenshot = {
  available: (): boolean => typeof bridge()?.screenshot?.capture === 'function',
  async capture(opts: { mode: 'interactive' | 'file'; path?: string }): Promise<ScreenshotResult> {
    let r: Record<string, unknown> | null;
    try {
      r = ((await bridge()?.screenshot?.capture?.(opts)) ?? null) as Record<string, unknown> | null;
    } catch (e) {
      throw captureError(e);
    }
    if (!r || r['cancelled'] === true) return { outcome: 'cancelled' };
    if (typeof r['error'] === 'string') throw captureError({ message: r['error'], code: r['error'] });
    const description = typeof r['description'] === 'string' ? r['description'].trim() : '';
    const visibleText = typeof r['visible_text'] === 'string' ? r['visible_text'].trim() : '';
    // Spec 03 §4: under 20 characters of text and nothing to say about it → nothing is saved, and the sheet says so.
    if (r['empty'] === true || r['nothing'] === true || (!description && visibleText.length < 20)) return { outcome: 'nothing' };
    return {
      outcome: 'captured',
      imagePath: typeof r['image_path'] === 'string' ? r['image_path'] : '',
      title: typeof r['title'] === 'string' && r['title'].trim() ? r['title'].trim() : description.split(/[.—\n]/)[0]!.slice(0, 80),
      description,
      visibleText,
      entities: Array.isArray(r['entities']) ? r['entities'].filter((e): e is string => typeof e === 'string') : [],
      facts: toFacts(r['facts']),
    };
  },
  /** Electron removed `File.path`; the preload may expose `webUtils.getPathForFile`. '' when neither exists. */
  pathForFile(file: File): string {
    try {
      return bridge()?.screenshot?.pathForFile?.(file) || (file as File & { path?: string }).path || '';
    } catch {
      return '';
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
