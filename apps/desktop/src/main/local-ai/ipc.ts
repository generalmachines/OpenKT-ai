/** Electron wiring for LocalAi: the only file here (with smoke.ts) that imports `electron`. */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { IpcChannel, LocalAiStatusDto, ModelsProgressDto, ModelsSetupInfoDto } from '../../shared/ipc';
import { DownloadController } from '../models/controller';
import { chooseModels, loadManifest, whisperFromEnv } from '../models/manifest';
import { setupInfo } from '../models/setup';
import { extractNote } from './agents';
import { LlamaLocalAi } from './local-ai';

let instance: LlamaLocalAi | null = null;

/** Packaged: Contents/Resources/llama. Dev: apps/desktop/resources/llama (scripts/fetch-llama.mjs). */
export function llamaDir(): string {
  if (process.env['OPENKT_LLAMA_DIR']) return process.env['OPENKT_LLAMA_DIR'];
  return app.isPackaged ? join(process.resourcesPath, 'llama') : join(app.getAppPath(), 'resources', 'llama');
}

export function modelsDir(): string {
  return process.env['OPENKT_MODELS_DIR'] || join(app.getPath('userData'), 'models');
}

export function getLocalAi(): LlamaLocalAi {
  if (!instance) {
    const tier = process.env['OPENKT_MODEL_TIER'];
    const plan = chooseModels(loadManifest(), totalmem(), tier === '2b' || tier === '4b' ? tier : undefined, whisperFromEnv(process.env['OPENKT_WHISPER_MODEL']));
    instance = new LlamaLocalAi({ llamaDir: llamaDir(), modelsDir: modelsDir(), plan, log: (l) => console.log(l) });
  }
  return instance;
}

// ── one download for the whole app (first launch, onboarding, Settings → Models) ──────────────
let controller: DownloadController | null = null;
let listWindows: () => BrowserWindow[] = () => [];

/** Same rule as capture/ipc.ts `capturePaths()` (not imported: that file imports this one). */
function helperDir(name: 'whisper' | 'ocr', env: string): string {
  if (process.env[env]) return process.env[env] as string;
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

async function readSetupInfo(): Promise<ModelsSetupInfoDto> {
  const ai = getLocalAi();
  const status = await ai.status();
  return setupInfo({
    models: status.models,
    modelsDir: modelsDir(),
    totalMemBytes: totalmem(),
    paused: getController().paused,
    binaries: { runtime: status.binary, transcriber: join(helperDir('whisper', 'OPENKT_WHISPER_DIR'), 'whisper-cli'), textReader: join(helperDir('ocr', 'OPENKT_OCR_DIR'), 'openkt-ocr') },
  });
}

function getController(): DownloadController {
  controller ??= new DownloadController({
    ensure: (onProgress, roles, signal) => getLocalAi().ensureModels(onProgress, roles, signal),
    emit: (p: ModelsProgressDto) => {
      for (const w of listWindows()) if (!w.isDestroyed()) w.webContents.send('models:progress' satisfies IpcChannel, p);
    },
    enoughDisk: async () => (await readSetupInfo()).enoughDisk,
    log: (l) => console.error(l),
  });
  return controller;
}

export function registerLocalAiIpc(windows: () => BrowserWindow[]): void {
  const ai = getLocalAi();
  listWindows = windows;
  const handle = (channel: IpcChannel, fn: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle('models:status', (): Promise<LocalAiStatusDto> => ai.status());
  // Resolves once embeddings + LLM are on disk; speech and the vision projector follow in the same run.
  handle('models:ensure', async () => {
    const r = await getController().start();
    return r.ok ? { ok: true as const, status: await ai.status() } : { ok: false as const, error: r.error, status: await ai.status() };
  });
  handle('models:setup-info', () => readSetupInfo());
  handle('models:pause', async () => (getController().pause(), readSetupInfo()));
  handle('models:resume', async () => (void getController().resume(), readSetupInfo()));
  handle('local-ai:extract-note', (input) => extractNote(ai, (input ?? {}) as { text: string }));
  handle('local-ai:embed', (texts, kind) => {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) throw new Error('texts must be string[]');
    return ai.embed(texts as string[], kind === 'query' ? 'query' : 'document');
  });
}

/** First launch: start fetching models without being asked. Errors surface through models:status. */
export function autoEnsureModels(windows: () => BrowserWindow[]): void {
  if (process.env['OPENKT_NO_AUTO_MODELS'] === '1') return;
  listWindows = windows;
  void getController().start({ auto: true });
}

export function disposeLocalAi(): void {
  instance?.killNow();
}
