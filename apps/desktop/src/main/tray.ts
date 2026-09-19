import { Menu, Tray, nativeImage } from 'electron';
import * as path from 'node:path';

export interface TrayActions {
  newVoiceNote(): void;
  captureScreenshot(): void;
  openApp(): void;
  /** Stub-only helper so the meeting prompt can be seen without a real call. */
  simulateMeeting?: () => void;
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
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
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
