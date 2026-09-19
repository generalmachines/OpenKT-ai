/**
 * The renderer's view of the first-run halves of the Electron bridge: system permissions and
 * the on-device AI download. Same rule as ./bridge.ts — everything degrades. In a browser
 * (vite dev, the screenshot run, tests) `window.openkt` is absent: permissions read as
 * `unsupported` and the models half is simply not available.
 */
import type { ModelsSetupInfoDto, OpenKTBridge } from '../shared/ipc';
import { UNSUPPORTED_PERMISSIONS, type PermissionKind, type PermissionsStatusDto } from '../shared/permissions';

export type { ModelsSetupInfoDto, PermissionKind, PermissionsStatusDto };

type Loose = Partial<Pick<OpenKTBridge, 'permissions' | 'models' | 'app'>>;
const bridge = (): Loose | undefined => (typeof window === 'undefined' ? undefined : (window.openkt as Loose | undefined));

const STATES = new Set(['granted', 'denied', 'not-determined', 'restricted', 'unsupported']);

function toStatus(v: unknown): PermissionsStatusDto {
  const j = (v ?? {}) as Record<string, unknown>;
  const pick = (k: PermissionKind) => (STATES.has(j[k] as string) ? (j[k] as PermissionsStatusDto[PermissionKind]) : 'unsupported');
  return { microphone: pick('microphone'), screen: pick('screen'), accessibility: pick('accessibility'), systemAudio: pick('systemAudio'), relaunchSuggested: j['relaunchSuggested'] === true };
}

export const permissions = {
  available: (): boolean => typeof bridge()?.permissions?.status === 'function',
  async status(): Promise<PermissionsStatusDto> {
    const p = bridge()?.permissions;
    if (typeof p?.status !== 'function') return { ...UNSUPPORTED_PERMISSIONS };
    try {
      return toStatus(await p.status());
    } catch {
      return { ...UNSUPPORTED_PERMISSIONS };
    }
  },
  async request(kind: PermissionKind): Promise<PermissionsStatusDto> {
    const p = bridge()?.permissions;
    if (typeof p?.request !== 'function') return { ...UNSUPPORTED_PERMISSIONS };
    try {
      return toStatus(await p.request(kind));
    } catch {
      return this.status();
    }
  },
  async openSettings(kind: PermissionKind): Promise<void> {
    try {
      await bridge()?.permissions?.openSettings?.(kind);
    } catch {
      /* nothing to open in a browser */
    }
  },
  onChange(listener: (s: PermissionsStatusDto) => void): () => void {
    const p = bridge()?.permissions;
    if (typeof p?.onChange !== 'function') return () => undefined;
    return p.onChange((s) => listener(toStatus(s)));
  },
  async relaunch(): Promise<void> {
    await bridge()?.permissions?.relaunch?.();
  },
};

function toSetupInfo(v: unknown): ModelsSetupInfoDto | null {
  const j = v as Partial<ModelsSetupInfoDto> | null;
  if (!j || typeof j !== 'object' || typeof j.totalBytes !== 'number') return null;
  const b = (j.bundled ?? {}) as Partial<ModelsSetupInfoDto['bundled']>;
  return {
    totalBytes: j.totalBytes,
    remainingBytes: typeof j.remainingBytes === 'number' ? j.remainingBytes : 0,
    freeBytes: typeof j.freeBytes === 'number' ? j.freeBytes : null,
    neededBytes: typeof j.neededBytes === 'number' ? j.neededBytes : 0,
    enoughDisk: j.enoughDisk !== false,
    totalMemBytes: typeof j.totalMemBytes === 'number' ? j.totalMemBytes : 0,
    smallModel: j.smallModel === true,
    paused: j.paused === true,
    chosen: j.chosen === true,
    bundled: { runtime: b.runtime === true, transcriber: b.transcriber === true, textReader: b.textReader === true },
  };
}

export type ModelRole = 'embed' | 'llm' | 'whisper' | 'mmproj';
export type ModelRowState = 'missing' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';

/** One model on the first-run screen. Unlike ./bridge.ts `ModelStatus` it keeps the role and the speed. */
export interface ModelRow {
  role: ModelRole;
  id: string;
  file: string;
  totalBytes: number;
  receivedBytes: number;
  state: ModelRowState;
  /** Only while this file is transferring; 0 otherwise. */
  bytesPerSec: number;
  error?: string;
  /** The open-source model: its name, licence (SPDX), original model card, and where the file comes from. */
  name?: string;
  license?: string;
  card?: string;
  source?: string;
}

const ROLES = new Set<ModelRole>(['embed', 'llm', 'whisper', 'mmproj']);
const ROW_STATES = new Set<ModelRowState>(['missing', 'partial', 'downloading', 'verifying', 'ready', 'error']);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Accepts a `ModelStatusDto` or a `ModelsProgressDto`. null for anything that is not one. */
export function toModelRow(v: unknown): ModelRow | null {
  const j = (v ?? null) as Record<string, unknown> | null;
  if (!j || typeof j !== 'object' || !ROLES.has(j['role'] as ModelRole)) return null;
  const state = ROW_STATES.has(j['state'] as ModelRowState) ? (j['state'] as ModelRowState) : 'missing';
  return {
    role: j['role'] as ModelRole,
    id: typeof j['id'] === 'string' ? j['id'] : String(j['role']),
    file: typeof j['file'] === 'string' ? j['file'] : '',
    totalBytes: n(j['totalBytes']),
    receivedBytes: n(j['receivedBytes']),
    state,
    bytesPerSec: state === 'downloading' ? n(j['bytesPerSec']) : 0,
    ...(typeof j['error'] === 'string' && j['error'] ? { error: j['error'] } : {}),
    // Progress events carry none of these; leaving them out keeps what status() said when the two are merged.
    ...(typeof j['name'] === 'string' ? { name: j['name'] } : {}),
    ...(typeof j['license'] === 'string' ? { license: j['license'] } : {}),
    ...(typeof j['card'] === 'string' && j['card'].startsWith('https://huggingface.co/') ? { card: j['card'] } : {}),
    ...(typeof j['source'] === 'string' && j['source'].startsWith('https://huggingface.co/') ? { source: j['source'] } : {}),
  };
}

/** The download's facts and controls. `setupInfo()` is null without the desktop app (or an older main). */
export const modelsSetup = {
  available: (): boolean => typeof bridge()?.models?.setupInfo === 'function',
  /** null without the model IPC. */
  async status(): Promise<ModelRow[] | null> {
    const m = bridge()?.models;
    if (typeof m?.status !== 'function') return null;
    try {
      const s = (await m.status()) as { models?: unknown } | null;
      return (Array.isArray(s?.models) ? s.models : []).map(toModelRow).filter((r): r is ModelRow => r !== null);
    } catch {
      return null;
    }
  },
  onProgress(listener: (row: ModelRow) => void): () => void {
    const m = bridge()?.models;
    if (typeof m?.onProgress !== 'function') return () => undefined;
    return m.onProgress((p) => {
      const row = toModelRow(p);
      if (row) listener(row);
    });
  },
  /**
   * The person's choice to download: everything, or just the models a feature needs (they go first).
   * Joins a run in flight. Resolves with why it stopped (`paused`, `low_disk`, a message), or null once
   * those models (search + understanding, for everything) are on disk.
   */
  async ensure(roles?: ModelRole[]): Promise<string | null> {
    const m = bridge()?.models;
    if (typeof m?.ensure !== 'function') return 'unavailable';
    try {
      const r = (await m.ensure(roles)) as { ok?: boolean; error?: unknown } | null;
      return r && r.ok === false ? (typeof r.error === 'string' && r.error ? r.error : 'failed') : null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  async setupInfo(): Promise<ModelsSetupInfoDto | null> {
    const m = bridge()?.models;
    if (typeof m?.setupInfo !== 'function') return null;
    try {
      return toSetupInfo(await m.setupInfo());
    } catch {
      return null;
    }
  },
  async pause(): Promise<ModelsSetupInfoDto | null> {
    try {
      return toSetupInfo(await bridge()?.models?.pause?.());
    } catch {
      return null;
    }
  },
  async resume(): Promise<ModelsSetupInfoDto | null> {
    try {
      return toSetupInfo(await bridge()?.models?.resume?.());
    } catch {
      return null;
    }
  },
};

/** True when "Try it" can open the voice pill or the screenshot picker (the desktop app). */
export const captureAvailable = (): boolean => typeof bridge()?.app?.startCapture === 'function';

/** Shortcut ids another app already holds (Electron could not register them). Empty without the desktop app. */
export async function hotkeysTaken(): Promise<Set<string>> {
  try {
    const list = (await bridge()?.app?.hotkeys?.()) ?? [];
    return new Set(list.filter((h) => h.fallbackAccelerator !== null && !h.registered).map((h) => h.id));
  } catch {
    return new Set();
  }
}

/** "Try it": the same thing the hotkey does. Resolves false when there is no desktop app to do it. */
export async function startCapture(kind: 'voice' | 'screenshot'): Promise<boolean> {
  const a = bridge()?.app;
  if (typeof a?.startCapture !== 'function') return false;
  try {
    await a.startCapture(kind);
    return true;
  } catch {
    return false;
  }
}
