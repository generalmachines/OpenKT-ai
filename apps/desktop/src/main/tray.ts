import { Menu, Tray, nativeImage } from 'electron';
import * as path from 'node:path';

export interface TrayActions {
  newVoiceNote(): void;
  captureScreenshot(): void;
  openApp(): void;
  /** Stub-only helper so the meeting prompt can be seen without a real call. */
  simulateMeeting?: () => void;
  /** In-app updates: "Check for Updates…" (src/main/update/ipc.ts). */
  checkForUpdates?: () => void;
}

let tray: Tray | null = null;

export function createTray(actions: TrayActions): Tray {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'trayTemplate.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  if (icon.isEmpty() && process.platform === 'darwin') tray.setTitle('KT');
  tray.setToolTip('OpenKT');

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'New voice note', click: actions.newVoiceNote },
    { label: 'Capture screenshot', click: actions.captureScreenshot },
    { type: 'separator' },
    { label: 'Open OpenKT', click: actions.openApp },
  ];
  if (actions.simulateMeeting) {
    items.push({ type: 'separator' }, { label: 'Simulate a meeting (stub engine)', click: actions.simulateMeeting });
  }
  if (actions.checkForUpdates) items.push({ type: 'separator' }, { label: 'Check for Updates…', click: actions.checkForUpdates });
  items.push({ type: 'separator' }, { label: 'Quit OpenKT', role: 'quit' });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  return tray;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export function applyAppMenu(actions: TrayActions): void {
  const isMac = process.platform === 'darwin';
  // The standard macOS app menu, plus "Check for Updates…" under "About OpenKT" (in-app updates).
  const appMenu: Electron.MenuItemConstructorOptions = actions.checkForUpdates
    ? {
        label: 'OpenKT',
        submenu: [
          { role: 'about' },
          { label: 'Check for Updates…', click: actions.checkForUpdates },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : { role: 'appMenu' };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New voice note', accelerator: 'CmdOrCtrl+Shift+N', click: actions.newVoiceNote },
        { label: 'Capture screenshot', accelerator: 'CmdOrCtrl+Shift+S', click: actions.captureScreenshot },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
