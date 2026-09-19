import { app, ipcMain, session } from 'electron';
import type { CaptureEvent, IpcChannel, OverlayKind } from '../shared/ipc';
import { createCaptureService, type MeetingDetected } from './capture';
import { StubEngine } from './engine/stub';
import { autoEnsureModels, disposeLocalAi, registerLocalAiIpc } from './local-ai/ipc';
import { isSmoke, runSmoke } from './local-ai/smoke';
import { registerNetIpc } from './net';
import { registerShortcuts, shortcutStatus, unregisterShortcuts } from './shortcuts';
import { applyAppMenu, createTray, destroyTray, type TrayActions } from './tray';
import { allWindows, closeOverlay, hardenWebContents, openMainWindow, showOverlay } from './windows';

// The seam: swap StubEngine for the Swift engine client here, nothing else changes.
const engine = new StubEngine();
const capture = createCaptureService(engine);
let pendingMeeting: MeetingDetected | null = null;

const handle = (channel: IpcChannel, fn: (...args: unknown[]) => unknown) =>
  ipcMain.handle(channel, (_event, ...args) => fn(...args));

function broadcast(event: CaptureEvent): void {
  for (const win of allWindows()) win.webContents.send('capture:event' satisfies IpcChannel, event);
}

async function startVoiceNote(): Promise<void> {
  await showOverlay('voice');
  await capture.startVoice();
}

async function toggleVoice(): Promise<void> {
  if (capture.isListening) await capture.stopVoice();
  else await startVoiceNote();
}

async function captureScreenshot(): Promise<void> {
  await showOverlay('screenshot');
  await capture.captureScreenshot();
}

function isOverlayKind(v: unknown): v is OverlayKind {
  return v === 'voice' || v === 'meeting' || v === 'screenshot';
}

function registerIpc(): void {
  handle('capture:start-voice', () => capture.startVoice());
  handle('capture:stop-voice', async () => void (await capture.stopVoice()));
  handle('capture:screenshot', async () => void (await capture.captureScreenshot()));
  handle('capture:meeting-response', async (record) => {
    const meeting = pendingMeeting;
    pendingMeeting = null;
    closeOverlay('meeting');
    if (!meeting) return;
    await meeting.respond(record === true);
    if (record === true) await showOverlay('recording');
  });
  handle('capture:stop-meeting', async () => {
    await capture.stopMeeting();
    closeOverlay('recording');
  });
  handle('overlay:close', async (kind) => {
    if (!isOverlayKind(kind)) return;
    if (kind === 'voice' && capture.isListening) await capture.stopVoice();
    closeOverlay(kind);
  });
  handle('app:open-main', (route) => void openMainWindow(typeof route === 'string' && route.startsWith('/') ? route : undefined));
  handle('app:hotkeys', () => shortcutStatus());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void openMainWindow());

  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));

  void app.whenReady().then(async () => {
    // The renderer never needs a browser permission: the engine owns the mic and screen.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    registerIpc();
    registerLocalAiIpc(allWindows);
    if (isSmoke()) return void runSmoke(() => openMainWindow());
    registerNetIpc();
    capture.onEvent(broadcast);
    capture.onMeetingDetected((meeting) => {
      pendingMeeting = meeting;
      void showOverlay('meeting');
    });
    await engine.start();

    const actions: TrayActions = {
      newVoiceNote: () => void startVoiceNote(),
      captureScreenshot: () => void captureScreenshot(),
      openApp: () => void openMainWindow(),
      simulateMeeting: () => engine.simulateMeetingDetected(),
    };
    applyAppMenu(actions);
    createTray(actions);
    registerShortcuts({ toggleVoice: () => void toggleVoice(), captureScreenshot: () => void captureScreenshot() });

    await openMainWindow();
    autoEnsureModels(allWindows);
    app.on('activate', () => void openMainWindow());
  });

  // Menu-bar app: closing the window keeps capture available from the tray.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && process.env['OPENKT_QUIT_ON_CLOSE'] === '1') app.quit();
  });

  app.on('will-quit', () => {
    unregisterShortcuts();
    destroyTray();
    void capture.dispose();
    disposeLocalAi();
  });
}
