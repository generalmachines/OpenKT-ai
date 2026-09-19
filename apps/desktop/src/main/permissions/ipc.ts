/** Electron wiring for ./service.ts — the only file here that imports `electron`. */
import { app, desktopCapturer, ipcMain, session, shell, systemPreferences, type BrowserWindow, type WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcChannel } from '../../shared/ipc';
import { isPermissionKind, type PermissionsStatusDto } from '../../shared/permissions';
import { PermissionsService, type PermissionFlags } from './service';

let service: PermissionsService | null = null;

const flagsPath = () => join(app.getPath('userData'), 'permissions.json');

const flags = {
  read(): PermissionFlags {
    try {
      return JSON.parse(readFileSync(flagsPath(), 'utf8')) as PermissionFlags;
    } catch {
      return {};
    }
  },
  write(next: PermissionFlags): void {
    try {
      writeFileSync(flagsPath(), JSON.stringify(next));
    } catch {
      /* the next launch simply offers "Allow" again */
    }
  },
};

export function getPermissions(): PermissionsService {
  service ??= new PermissionsService({
    platform: process.platform,
    systemPreferences: {
      getMediaAccessStatus: (t) => systemPreferences.getMediaAccessStatus(t),
      askForMediaAccess: (t) => systemPreferences.askForMediaAccess(t),
      isTrustedAccessibilityClient: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
    },
    probeScreen: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }),
    openExternal: (url) => shell.openExternal(url),
    relaunch: async () => {
      // The renderer keeps the onboarding step in localStorage; make sure it is on disk before the process goes away.
      await session.defaultSession.flushStorageData();
      app.relaunch();
      app.exit(0);
    },
    flags,
  });
  return service;
}

export function registerPermissionsIpc(windows: () => BrowserWindow[]): void {
  const svc = getPermissions();
  const handle = (channel: IpcChannel, fn: (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => ipcMain.handle(channel, (e, ...args) => fn(e, ...args));

  handle('permissions:status', () => svc.status());
  handle('permissions:request', (_e, kind) => (isPermissionKind(kind) ? svc.request(kind) : svc.status()));
  handle('permissions:open-settings', (_e, kind) => (isPermissionKind(kind) ? svc.openSettings(kind) : undefined));
  handle('permissions:relaunch', () => svc.relaunch());

  // One poll for the whole app, alive while any window is watching. A window that goes away stops watching.
  const watchers = new Map<WebContents, number>();
  let stop: (() => void) | null = null;
  const push = (s: PermissionsStatusDto) => {
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.send('permissions:changed' satisfies IpcChannel, s);
  };
  const sync = () => {
    if (watchers.size > 0 && !stop) stop = svc.watch(push);
    if (watchers.size === 0 && stop) {
      stop();
      stop = null;
    }
  };
  handle('permissions:watch', (e, on) => {
    const wc = e.sender;
    const n = (watchers.get(wc) ?? 0) + (on === true ? 1 : -1);
    if (n > 0) {
      if (!watchers.has(wc)) wc.once('destroyed', () => (watchers.delete(wc), sync()));
      watchers.set(wc, n);
    } else watchers.delete(wc);
    sync();
  });

  // Coming back from System Settings: check straight away instead of waiting for the next poll.
  app.on('browser-window-focus', () => void (watchers.size > 0 && svc.check()));
}
