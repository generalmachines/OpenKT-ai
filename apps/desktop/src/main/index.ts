import { app, ipcMain, session } from 'electron';
import type { CaptureEvent, IpcChannel, OverlayKind } from '../shared/ipc';
import { registerAuthIpc } from './auth/ipc';
import { createCaptureService, type MeetingDetected } from './capture';
import { getVoice, installPermissionPolicy, registerCaptureIpc } from './capture/ipc';
import { StubEngine } from './engine/stub';
import { autoEnsureModels, disposeLocalAi, registerLocalAiIpc } from './local-ai/ipc';
import { isSmoke, runSmoke } from './local-ai/smoke';
import { registerNetIpc } from './net';
import { registerPermissionsIpc } from './permissions/ipc';
import { registerShortcuts, shortcutStatus, unregisterShortcuts } from './shortcuts';
import { applyAppMenu, createTray, destroyTray, type TrayActions } from './tray';
import { allWindows, closeOverlay, hardenWebContents, openMainWindow, showOverlay } from './windows';
// ── in-app updates ──
import { checkForUpdatesFromMenu, isUpdateSmoke, registerUpdateIpc } from './update/ipc';
import { runUpdateSmoke } from './update/smoke';
// ── end in-app updates ──

// Voice notes and screenshots are real (./capture/ipc.ts). The stub engine remains for MEETINGS only.
const engine = new StubEngine();
const capture = createCaptureService(engine);
let pendingMeeting: MeetingDetected | null = null;

const handle = (channel: IpcChannel, fn: (...args: unknown[]) => unknown) =>
  ipcMain.handle(channel, (_event, ...args) => fn(...args));

function broadcast(event: CaptureEvent): void {
  for (const win of allWindows()) win.webContents.send('capture:event' satisfies IpcChannel, event);
}

/**
 * Voice: the overlay window records and drives voice.begin/chunk/end itself. The hotkey only
 * opens it, and on the next press tells it to stop (then save) with a `voice.final` event —
 * the signal the overlay already listens for.
 */
let voiceOverlay: Electron.BrowserWindow | null = null;
/** See 'overlay:close' below. */
let ignoreVoiceCloseBetween: [number, number] = [0, 0];

async function startVoiceNote(): Promise<void> {
  voiceOverlay = await showOverlay('voice');
}

async function toggleVoice(): Promise<void> {
  if (!voiceOverlay || voiceOverlay.isDestroyed()) return startVoiceNote();
  if (getVoice().activeCount > 0) ignoreVoiceCloseBetween = [Date.now() + 1100, Date.now() + 1800];
  voiceOverlay.webContents.send('capture:event' satisfies IpcChannel, { type: 'voice.final', captureId: 'hotkey', text: '', durationSec: 0 } satisfies CaptureEvent);
}

/** The overlay calls screenshot.capture({mode:'interactive'}) when it mounts; main hides it while the picker is up. */
async function captureScreenshot(): Promise<void> {
  await showOverlay('screenshot');
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
    // The overlay's pre-IPC listener closes the window 1.4 s after any `voice.final`, which would
    // cut off a transcription the hotkey just started. Ignore exactly that close while a recording
    // is still held (save, discard and "nothing heard" all release it first). Remove with that listener.
    const now = Date.now();
    if (kind === 'voice' && now >= ignoreVoiceCloseBetween[0] && now <= ignoreVoiceCloseBetween[1] && getVoice().activeCount > 0) return;
    closeOverlay(kind);
  });
  handle('app:open-main', (route) => void openMainWindow(typeof route === 'string' && route.startsWith('/') ? route : undefined));
  handle('app:hotkeys', () => shortcutStatus());
  // first run "Try it": the same thing the hotkey does, for the person whose hotkey is taken by another app.
  handle('app:start-capture', (kind) => void (kind === 'screenshot' ? captureScreenshot() : toggleVoice()));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void openMainWindow());

  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));

  void app.whenReady().then(async () => {
    // The voice overlay records with getUserMedia: microphone for the app's own pages, nothing else.
    installPermissionPolicy(session.defaultSession);

    registerIpc();
    registerLocalAiIpc(allWindows);
    registerCaptureIpc();
    registerPermissionsIpc(allWindows); // first run: system permissions (src/main/permissions)
    if (isUpdateSmoke()) return void runUpdateSmoke(); // in-app updates: CI job update-smoke
    if (isSmoke()) return void runSmoke(() => openMainWindow());
    registerNetIpc();
    registerAuthIpc(() => void openMainWindow());
    void registerUpdateIpc(allWindows); // in-app updates
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
      checkForUpdates: () => checkForUpdatesFromMenu((route) => openMainWindow(route)), // in-app updates
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
