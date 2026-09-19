import { BrowserWindow, screen, shell } from 'electron';
import * as path from 'node:path';
import type { OverlayKind } from '../shared/ipc';

const DEV_URL = process.env['OPENKT_DEV_URL'];
const RENDERER_INDEX = path.join(__dirname, '..', '..', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

/** Same hardened settings for every window. */
const WEB_PREFERENCES: Electron.WebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
};

function load(win: BrowserWindow, route: string): Promise<void> {
  if (DEV_URL) return win.loadURL(`${DEV_URL}/#${route}`);
  return win.loadFile(RENDERER_INDEX, { hash: route });
}

function isAppUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith('file://');
}

/** Applied to every webContents: no new windows, no navigation away from the app. */
export function hardenWebContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export async function openMainWindow(route?: string): Promise<BrowserWindow> {
  const existing = getMainWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (route) existing.webContents.send('app:navigate', route);
    return existing;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'OpenKT',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
  });
  await load(win, route ?? '/');
  return win;
}

interface OverlaySpec {
  route: string;
  width: number;
  height: number;
  place: 'bottom-center' | 'top-right';
  focusable: boolean;
}

/** Sizes are the artboard components plus an 8px transparent margin. */
const OVERLAYS: Record<OverlayKind | 'recording', OverlaySpec> = {
  voice: { route: '/overlay/voice', width: 536, height: 244, place: 'bottom-center', focusable: true },
  screenshot: { route: '/overlay/screenshot', width: 536, height: 132, place: 'bottom-center', focusable: true },
  meeting: { route: '/overlay/meeting', width: 376, height: 216, place: 'top-right', focusable: true },
  recording: { route: '/overlay/recording', width: 420, height: 56, place: 'bottom-center', focusable: false },
};

const overlays = new Map<string, BrowserWindow>();

export async function showOverlay(kind: OverlayKind | 'recording'): Promise<BrowserWindow> {
  const open = overlays.get(kind);
  if (open && !open.isDestroyed()) {
    open.showInactive();
    return open;
  }
  const spec = OVERLAYS[kind];
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const x = spec.place === 'top-right' ? area.x + area.width - spec.width - 16 : area.x + Math.round((area.width - spec.width) / 2);
  const y = spec.place === 'top-right' ? area.y + 16 : area.y + area.height - spec.height - 32;

  const win = new BrowserWindow({
    x,
    y,
    width: spec.width,
    height: spec.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: spec.focusable,
    show: false,
    webPreferences: WEB_PREFERENCES,
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlays.set(kind, win);
  win.on('closed', () => overlays.delete(kind));
  win.once('ready-to-show', () => win.showInactive());
  await load(win, spec.route);
  return win;
}

export function closeOverlay(kind: OverlayKind | 'recording'): void {
  const win = overlays.get(kind);
  if (win && !win.isDestroyed()) win.close();
  overlays.delete(kind);
}

export function allWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}
