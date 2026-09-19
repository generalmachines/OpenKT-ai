/**
 * Preload: the only code that touches both worlds. Runs sandboxed with
 * context isolation, so it may require nothing but `electron`, and exposes a
 * small, typed, promise-based surface — no raw ipcRenderer, no Node.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CaptureEvent, HotkeyInfo, IpcChannel, OpenKTBridge, OverlayKind } from '../shared/ipc';

const ch = <C extends IpcChannel>(c: C): C => c;

function listen<T>(channel: IpcChannel, listener: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: OpenKTBridge = {
  platform: process.platform,
  versions: { app: process.env['npm_package_version'] ?? '', electron: process.versions.electron ?? '' },
  capture: {
    startVoice: () => ipcRenderer.invoke(ch('capture:start-voice')),
    stopVoice: () => ipcRenderer.invoke(ch('capture:stop-voice')),
    captureScreenshot: () => ipcRenderer.invoke(ch('capture:screenshot')),
    respondToMeeting: (record: boolean) => ipcRenderer.invoke(ch('capture:meeting-response'), record === true),
    stopMeeting: () => ipcRenderer.invoke(ch('capture:stop-meeting')),
    onEvent: (listener) => listen<CaptureEvent>(ch('capture:event'), listener),
  },
  overlay: {
    close: (kind: OverlayKind) => ipcRenderer.invoke(ch('overlay:close'), kind),
  },
  app: {
    openMain: (route?: string) => ipcRenderer.invoke(ch('app:open-main'), typeof route === 'string' ? route : undefined),
    hotkeys: () => ipcRenderer.invoke(ch('app:hotkeys')) as Promise<HotkeyInfo[]>,
    onNavigate: (listener) => listen<string>(ch('app:navigate'), listener),
  },
};

contextBridge.exposeInMainWorld('openkt', bridge);
