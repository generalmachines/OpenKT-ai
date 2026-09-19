/**
 * Preload: the only code that touches both worlds. Runs sandboxed with
 * context isolation, so it may require nothing but `electron`, and exposes a
 * small, typed, promise-based surface — no raw ipcRenderer, no Node.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { CaptureEvent, HotkeyInfo, IpcChannel, ModelsProgressDto, NetRequest, NetResponse, OpenKTBridge, OverlayKind, PermissionsStatusDto } from '../shared/ipc';
import type { UpdateStatusDto } from '../shared/ipc';

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
    startCapture: (kind) => ipcRenderer.invoke(ch('app:start-capture'), kind === 'screenshot' ? 'screenshot' : 'voice'),
  },
  models: {
    status: () => ipcRenderer.invoke(ch('models:status')),
    ensure: (roles) => ipcRenderer.invoke(ch('models:ensure'), Array.isArray(roles) ? roles.filter((r) => ['embed', 'llm', 'whisper', 'mmproj'].includes(r)) : undefined),
    onProgress: (listener) => listen<ModelsProgressDto>(ch('models:progress'), listener),
    // ── first run (begin) ──
    setupInfo: () => ipcRenderer.invoke(ch('models:setup-info')),
    pause: () => ipcRenderer.invoke(ch('models:pause')),
    resume: () => ipcRenderer.invoke(ch('models:resume')),
    // ── first run (end) ──
  },
  // ── first run (begin) ──
  permissions: {
    status: () => ipcRenderer.invoke(ch('permissions:status')),
    request: (kind) => ipcRenderer.invoke(ch('permissions:request'), String(kind)),
    openSettings: (kind) => ipcRenderer.invoke(ch('permissions:open-settings'), String(kind)),
    onChange: (listener) => {
      const off = listen<PermissionsStatusDto>(ch('permissions:changed'), listener);
      void ipcRenderer.invoke(ch('permissions:watch'), true);
      return () => {
        off();
        void ipcRenderer.invoke(ch('permissions:watch'), false);
      };
    },
    relaunch: () => ipcRenderer.invoke(ch('permissions:relaunch')),
  },
  // ── first run (end) ──
  localAi: {
    extractNote: (input) => ipcRenderer.invoke(ch('local-ai:extract-note'), { ...input, text: String(input?.text ?? '') }),
    embed: (texts, kind) => ipcRenderer.invoke(ch('local-ai:embed'), texts, kind === 'query' ? 'query' : 'document'),
  },
  voice: {
    begin: () => ipcRenderer.invoke(ch('voice:begin')),
    chunk: (id, pcm16) => ipcRenderer.invoke(ch('voice:chunk'), String(id), pcm16),
    end: (id, opts) => ipcRenderer.invoke(ch('voice:end'), String(id), { language: opts?.language, keepAudio: opts?.keepAudio === true }),
    toSession: (id) => ipcRenderer.invoke(ch('voice:to-session'), String(id)),
    cancel: (id) => ipcRenderer.invoke(ch('voice:cancel'), String(id)),
  },
  screenshot: {
    capture: (opts) => ipcRenderer.invoke(ch('screenshot:capture'), { mode: opts?.mode === 'file' ? 'file' : 'interactive', path: typeof opts?.path === 'string' ? opts.path : undefined, caption: typeof opts?.caption === 'string' ? opts.caption : undefined }),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  net: {
    request: (req: NetRequest) => ipcRenderer.invoke(ch('net:request'), req) as Promise<NetResponse>,
  },
  auth: {
    google: {
      start: (input) => ipcRenderer.invoke(ch('auth:google:start'), { clientId: String(input?.clientId ?? ''), clientSecret: typeof input?.clientSecret === 'string' ? input.clientSecret : undefined }),
      cancel: () => ipcRenderer.invoke(ch('auth:google:cancel')),
    },
  },
  secureStore: {
    get: (key: string) => ipcRenderer.invoke(ch('secure:get'), key) as Promise<string | null>,
    set: (key: string, value: string) => ipcRenderer.invoke(ch('secure:set'), key, value) as Promise<void>,
    delete: (key: string) => ipcRenderer.invoke(ch('secure:delete'), key) as Promise<void>,
  },
  // ── in-app updates ──
  update: {
    status: () => ipcRenderer.invoke(ch('update:status')) as Promise<UpdateStatusDto>,
    check: () => ipcRenderer.invoke(ch('update:check')) as Promise<UpdateStatusDto>,
    download: () => ipcRenderer.invoke(ch('update:download')) as Promise<UpdateStatusDto>,
    install: () => ipcRenderer.invoke(ch('update:install')) as Promise<UpdateStatusDto>,
    setAuto: (on: boolean) => ipcRenderer.invoke(ch('update:set-auto'), on === true) as Promise<UpdateStatusDto>,
    moveToApplications: () => ipcRenderer.invoke(ch('update:move-to-applications')) as Promise<UpdateStatusDto>,
    rollback: () => ipcRenderer.invoke(ch('update:rollback')) as Promise<UpdateStatusDto>,
    seen: () => ipcRenderer.invoke(ch('update:seen')) as Promise<UpdateStatusDto>,
    onEvent: (listener) => listen<UpdateStatusDto>(ch('update:event'), listener),
  },
  // ── end in-app updates ──
};

contextBridge.exposeInMainWorld('openkt', bridge);
