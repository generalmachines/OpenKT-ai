/**
 * A FAKE Electron bridge for the first run: permissions, the model download and the "Try it"
 * capture hooks, all driven by the test. Installed as `window.openkt`; remove with `uninstall()`.
 */
import { vi } from 'vitest';
import type { ModelsSetupInfoDto, PermissionsStatusDto } from '../../src/shared/ipc';

export const GiB = 1024 ** 3;
type Role = 'embed' | 'llm' | 'whisper' | 'mmproj';

export interface FakeRow {
  role: Role;
  id: string;
  file: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'missing' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';
  error?: string;
  name?: string;
  license?: string;
  card?: string;
  source?: string;
}

/** As main reports them from models.manifest.json (a 16 GB Mac). */
const ABOUT: Record<Role, Pick<FakeRow, 'name' | 'license' | 'card' | 'source'>> = {
  embed: { name: 'Qwen3-Embedding-0.6B', license: 'Apache-2.0', card: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B', source: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF' },
  llm: { name: 'Qwen3.5-4B', license: 'Apache-2.0', card: 'https://huggingface.co/Qwen/Qwen3.5-4B', source: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF' },
  whisper: { name: 'Whisper large-v3-turbo', license: 'MIT', card: 'https://huggingface.co/openai/whisper-large-v3-turbo', source: 'https://huggingface.co/ggerganov/whisper.cpp' },
  mmproj: { name: 'Qwen3.5-4B vision', license: 'Apache-2.0', card: 'https://huggingface.co/Qwen/Qwen3.5-4B', source: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF' },
};

const SIZES: Record<Role, number> = { embed: 639_150_592, llm: 2_740_937_888, whisper: 574_041_195, mmproj: 672_423_616 };

export function rows(state: FakeRow['state'] | Partial<Record<Role, Partial<FakeRow>>> = 'missing'): FakeRow[] {
  return (['embed', 'llm', 'whisper', 'mmproj'] as const).map((role) => {
    const over = typeof state === 'string' ? { state } : (state[role] ?? {});
    const s = over.state ?? 'missing';
    return { role, id: role, file: `${role}.gguf`, path: '', totalBytes: SIZES[role], receivedBytes: s === 'ready' ? SIZES[role] : 0, state: s, ...ABOUT[role], ...over };
  });
}

export interface FakeOptions {
  perms?: Partial<PermissionsStatusDto>;
  rows?: FakeRow[];
  info?: Partial<ModelsSetupInfoDto>;
  /** What models.ensure resolves with (it gets the roles a feature asked for, or none for everything). */
  ensure?: (roles?: string[]) => Promise<{ ok: boolean; error?: string }>;
  hotkeys?: { id: string; registered: boolean; fallbackAccelerator: string | null; display: string }[];
}

export function installFirstRun(o: FakeOptions = {}) {
  const perms: PermissionsStatusDto = { microphone: 'not-determined', screen: 'not-determined', accessibility: 'not-determined', systemAudio: 'not-determined', relaunchSuggested: false, ...o.perms };
  const permListeners = new Set<(s: PermissionsStatusDto) => void>();
  const progressListeners = new Set<(p: unknown) => void>();
  let modelRows = o.rows ?? rows('missing');
  const total = modelRows.reduce((n, r) => n + r.totalBytes, 0);
  const info: ModelsSetupInfoDto = {
    totalBytes: total,
    remainingBytes: total,
    freeBytes: 80e9,
    neededBytes: total + GiB,
    enoughDisk: true,
    totalMemBytes: 16 * GiB,
    smallModel: false,
    paused: false,
    chosen: false,
    bundled: { runtime: true, transcriber: true, textReader: true },
    ...o.info,
  };

  const bridge = {
    platform: 'darwin',
    app: {
      onNavigate: () => () => undefined,
      openMain: vi.fn(async () => undefined),
      hotkeys: vi.fn(async () => o.hotkeys ?? [{ id: 'voice', display: 'fn', fallbackAccelerator: 'Control+Alt+Space', registered: true }, { id: 'screenshot', display: '⌃⌥S', fallbackAccelerator: 'Control+Alt+S', registered: true }]),
      startCapture: vi.fn(async (_kind: 'voice' | 'screenshot') => undefined),
    },
    capture: { onEvent: () => () => undefined },
    permissions: {
      status: vi.fn(async () => ({ ...perms })),
      request: vi.fn(async (kind: keyof PermissionsStatusDto) => {
        if (kind === 'microphone' && perms.microphone === 'not-determined') perms.microphone = 'granted';
        return { ...perms };
      }),
      openSettings: vi.fn(async () => undefined),
      onChange: vi.fn((l: (s: PermissionsStatusDto) => void) => {
        permListeners.add(l);
        return () => void permListeners.delete(l);
      }),
      relaunch: vi.fn(async () => undefined),
    },
    models: {
      status: vi.fn(async () => ({ models: modelRows.map((r) => ({ ...r })) })),
      ensure: vi.fn(o.ensure ?? (async (_roles?: string[]) => ({ ok: true }))),
      onProgress: vi.fn((l: (p: unknown) => void) => {
        progressListeners.add(l);
        return () => void progressListeners.delete(l);
      }),
      setupInfo: vi.fn(async () => ({ ...info })),
      pause: vi.fn(async () => ((info.paused = true), { ...info })),
      resume: vi.fn(async () => ((info.paused = false), { ...info })),
    },
    localAi: { extractNote: vi.fn(async () => ({ status: 'noop' })) },
  };
  (window as unknown as { openkt: unknown }).openkt = bridge;

  return {
    bridge,
    perms,
    info,
    /** What macOS says now (as the 1.5 s poll would push it). */
    setPerms(next: Partial<PermissionsStatusDto>) {
      Object.assign(perms, next);
      for (const l of permListeners) l({ ...perms });
    },
    /** A models:progress event from main. */
    progress(p: Partial<FakeRow> & { role: Role; bytesPerSec?: number }) {
      modelRows = modelRows.map((r) => (r.role === p.role ? { ...r, ...p } : r));
      const r = modelRows.find((x) => x.role === p.role)!;
      for (const l of progressListeners) l({ ...r, bytesPerSec: p.bytesPerSec ?? 0, overall: 0 });
    },
    setRows(next: FakeRow[]) {
      modelRows = next;
    },
  };
}

export function uninstall(): void {
  delete (window as unknown as { openkt?: unknown }).openkt;
}
