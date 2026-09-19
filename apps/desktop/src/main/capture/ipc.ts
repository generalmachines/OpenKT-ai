/** Electron wiring for voice notes and screenshots. With ../local-ai/ipc.ts and smoke.ts, the only capture file that imports `electron`. */
import { app, BrowserWindow, ipcMain, systemPreferences, type Session } from 'electron';
import { join } from 'node:path';
import type { IpcChannel } from '../../shared/ipc';
import { getLocalAi } from '../local-ai/ipc';
import { allowPermission } from './permissions';
import { createScreenshotService, createVoiceService, type CapturePaths } from './pipeline';
import type { ScreenshotService } from './screenshot';
import type { VoiceService } from './voice';

function resourceDir(name: 'whisper' | 'ocr', env: string): string {
  if (process.env[env]) return process.env[env] as string;
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

export function capturePaths(): CapturePaths {
  return { whisperDir: resourceDir('whisper', 'OPENKT_WHISPER_DIR'), ocrDir: resourceDir('ocr', 'OPENKT_OCR_DIR'), tmpDir: join(app.getPath('temp'), 'openkt-capture') };
}

/** macOS asks once; after a refusal only System Settings can change it, so this resolves false without a prompt. */
async function askMicrophone(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  return systemPreferences.askForMediaAccess('microphone');
}

let voice: VoiceService | null = null;
let screenshot: ScreenshotService | null = null;

export function getVoice(): VoiceService {
  voice ??= createVoiceService(getLocalAi(), capturePaths(), { askMicrophone, whisperCpuOnly: process.env['OPENKT_WHISPER_NO_GPU'] === '1', log: (l) => console.log(l) });
  return voice;
}

/** The picker must not photograph OpenKT's own floating overlays. */
let hidden: BrowserWindow[] = [];
const hideOverlays = () => {
  hidden = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isAlwaysOnTop() && w.isVisible());
  for (const w of hidden) w.hide();
};
const showOverlays = () => {
  for (const w of hidden) if (!w.isDestroyed()) w.showInactive();
  hidden = [];
};

export function getScreenshot(): ScreenshotService {
  screenshot ??= createScreenshotService(getLocalAi(), capturePaths(), {
    screenAccess: () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'),
    beforeInteractive: hideOverlays,
    afterInteractive: showOverlays,
  });
  return screenshot;
}

export function registerCaptureIpc(): void {
  const handle = (channel: IpcChannel, fn: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  handle('voice:begin', () => getVoice().begin());
  handle('voice:chunk', (id, data) => getVoice().chunk(String(id), data));
  handle('voice:end', (id, opts) => getVoice().end(String(id), (opts ?? {}) as { language?: string; keepAudio?: boolean }));
  handle('voice:to-session', (id) => getVoice().toSession(String(id)));
  handle('voice:cancel', (id) => getVoice().cancel(String(id)));
  handle('screenshot:capture', (opts) => getScreenshot().capture((opts ?? { mode: 'interactive' }) as { mode: 'interactive' | 'file'; path?: string; caption?: string }));
}

/** Microphone for the app's own pages; everything else stays denied (see permissions.ts). */
export function installPermissionPolicy(session: Session): void {
  const devUrl = process.env['OPENKT_DEV_URL'];
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(allowPermission(permission, { requestingUrl: details.requestingUrl || wc?.getURL() || '', mediaTypes, devUrl }));
  });
  session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    allowPermission(permission, { requestingUrl: requestingOrigin || wc?.getURL() || '', mediaTypes: [details.mediaType ?? 'unknown'], devUrl }),
  );
}
