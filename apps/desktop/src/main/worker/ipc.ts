/**
 * Electron wiring for the on-device worker: settings in userData/worker.json, the signed-in token
 * from the OS keychain (the same store the renderer writes), readiness from the local model, and
 * the `worker:*` channels for Settings → On-device AI.
 */
import { app, ipcMain, net, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import type { IpcChannel, WorkerConfigDto, WorkerStatusDto } from '../../shared/ipc';
import { getLocalAi } from '../local-ai/ipc';
import { chooseTier } from '../models/manifest';
import { secureGet } from '../net';
import { loadAgentsModule, loadPipelineModule } from './modules';
import { HttpJobsServer } from './protocol';
import { LocalWorker } from './worker';

/** The key src/api/index.ts stores the access token under. */
const TOKEN_KEY = 'server-token';

interface Saved {
  enabled: boolean;
  baseUrl: string | null;
  adapter: 'http' | 'mock' | null;
}

const settingsPath = () => join(app.getPath('userData'), 'worker.json');

function readSaved(): Saved {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Saved>;
    return { enabled: raw.enabled !== false, baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : null, adapter: raw.adapter === 'mock' ? 'mock' : raw.adapter === 'http' ? 'http' : null };
  } catch {
    // Default ON: a Mac that has the model helps keep its team's pages current.
    return { enabled: true, baseUrl: null, adapter: null };
  }
}

function writeSaved(s: Saved): void {
  try {
    const p = settingsPath();
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s), { mode: 0o600 });
  } catch {
    /* the choice simply does not persist */
  }
}

let worker: LocalWorker | null = null;
let saved: Saved = { enabled: true, baseUrl: null, adapter: null };

/** The same rule getLocalAi() uses to pick the model tier. */
function modelName(): string {
  const forced = process.env['OPENKT_MODEL_TIER'];
  const tier = forced === '2b' || forced === '4b' ? forced : chooseTier(totalmem());
  return tier === '2b' ? 'Qwen3.5-2B' : 'Qwen3.5-4B';
}

async function modelReady(): Promise<boolean> {
  const status = await getLocalAi().status();
  return status.binaryFound && status.models.some((m) => m.role === 'llm' && m.state === 'ready');
}

function toDto(): WorkerStatusDto {
  const s = worker!.status();
  return { ...s, configured: Boolean(saved.baseUrl && saved.adapter === 'http') };
}

export function registerWorkerIpc(windows: () => BrowserWindow[]): void {
  saved = readSaved();
  const ai = getLocalAi();
  const server = new HttpJobsServer(
    () => saved.baseUrl ?? '',
    async () => (saved.baseUrl && saved.adapter === 'http' ? secureGet(TOKEN_KEY) : null),
    (url, init) => net.fetch(url, init),
  );
  worker = new LocalWorker({
    server,
    enabled: saved.enabled,
    model: modelName(),
    workerName: () => `${hostname().replace(/\.local$/, '')} · ${modelName()}`,
    modules: async () => ({ agents: await loadAgentsModule(), pipeline: await loadPipelineModule() }),
    llm: async (agents) => new agents.OpenAiCompatibleClient({ baseUrl: await ai.chatBaseUrl(), model: 'local', timeoutMs: 180_000 }),
    readiness: async () => ({
      signedIn: Boolean(saved.baseUrl && saved.adapter === 'http' && secureGet(TOKEN_KEY)),
      modelReady: await modelReady().catch(() => false),
    }),
    log: (line) => console.log(line),
  });
  worker.onChange(() => {
    const dto = toDto();
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.send('worker:changed' satisfies IpcChannel, dto);
  });

  const handle = (channel: IpcChannel, fn: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  handle('worker:status', () => toDto());
  handle('worker:set-enabled', (on) => {
    saved = { ...saved, enabled: on === true };
    writeSaved(saved);
    worker!.setEnabled(saved.enabled);
    return toDto();
  });
  // The renderer says which server it is signed in to whenever that changes; the token itself
  // never crosses IPC again — main reads it from the keychain on every request.
  handle('worker:configure', (input) => {
    const c = (input ?? {}) as Partial<WorkerConfigDto>;
    const baseUrl = typeof c.baseUrl === 'string' && /^https?:\/\//i.test(c.baseUrl) ? c.baseUrl.replace(/\/+$/, '') : null;
    const adapter = c.adapter === 'http' ? 'http' : 'mock';
    const changed = baseUrl !== saved.baseUrl || adapter !== saved.adapter;
    saved = { ...saved, baseUrl, adapter };
    if (changed) writeSaved(saved);
    if (c.signedIn) worker!.poke();
    return toDto();
  });
  handle('worker:poke', () => (worker!.poke(), toDto()));

  worker.start();
}

export function disposeWorker(): void {
  worker?.stop();
}
