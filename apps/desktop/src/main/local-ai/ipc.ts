/** Electron wiring for LocalAi: the only file here (with smoke.ts) that imports `electron`. */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { IpcChannel, LocalAiStatusDto, ModelsProgressDto } from '../../shared/ipc';
import { chooseModels, loadManifest } from '../models/manifest';
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
    const plan = chooseModels(loadManifest(), totalmem(), tier === '2b' || tier === '4b' ? tier : undefined);
    instance = new LlamaLocalAi({ llamaDir: llamaDir(), modelsDir: modelsDir(), plan, log: (l) => console.log(l) });
  }
  return instance;
}

export function registerLocalAiIpc(windows: () => BrowserWindow[]): void {
  const ai = getLocalAi();
  const handle = (channel: IpcChannel, fn: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  const progress = (p: ModelsProgressDto) => {
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.send('models:progress' satisfies IpcChannel, p);
  };

  handle('models:status', (): Promise<LocalAiStatusDto> => ai.status());
  handle('models:ensure', async () => {
    try {
      // Embeddings + LLM are required; the vision projector is fetched last and is optional today.
      await ai.ensureModels(progress, ['embed', 'llm']);
      void ai.ensureModels(progress, ['mmproj']).catch(() => undefined);
      return { ok: true as const, status: await ai.status() };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, status: await ai.status() };
    }
  });
  handle('local-ai:extract-note', (input) => extractNote(ai, (input ?? {}) as { text: string }));
  handle('local-ai:embed', (texts, kind) => {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) throw new Error('texts must be string[]');
    return ai.embed(texts as string[], kind === 'query' ? 'query' : 'document');
  });
}

/** First launch: start fetching models without being asked. Errors surface through models:status. */
export function autoEnsureModels(windows: () => BrowserWindow[]): void {
  if (process.env['OPENKT_NO_AUTO_MODELS'] === '1') return;
  const ai = getLocalAi();
  const progress = (p: ModelsProgressDto) => {
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.send('models:progress' satisfies IpcChannel, p);
  };
  void ai
    .ensureModels(progress, ['embed', 'llm'])
    .then(() => ai.ensureModels(progress, ['mmproj']))
    .catch((e) => console.error('[models] download failed:', (e as Error).message));
}

export function disposeLocalAi(): void {
  instance?.killNow();
}
