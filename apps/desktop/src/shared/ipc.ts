/**
 * The contract between the Electron main process and the renderer.
 * Imported by both sides as TYPES ONLY (the sandboxed preload cannot require
 * local modules at runtime), so channel names are duplicated as literals in
 * src/preload/index.ts and checked against `IpcChannel` there.
 */

export type OverlayKind = 'voice' | 'meeting' | 'screenshot';

/** Events pushed from the capture module to any window that listens. */
export type CaptureEvent =
  | { type: 'voice.started'; captureId: string }
  | { type: 'voice.partial'; captureId: string; text: string; tentative: string; elapsedSec: number }
  | { type: 'voice.final'; captureId: string; text: string; durationSec: number }
  | { type: 'screenshot.captured'; captureId: string; description: string; visibleText: string }
  | { type: 'meeting.detected'; app: string }
  | { type: 'meeting.recording'; title: string; elapsedSec: number }
  | { type: 'meeting.stopped'; title: string; durationSec: number };

export interface HotkeyInfo {
  id: 'voice' | 'latch' | 'screenshot';
  /** What the user sees: "fn", "fn fn", "⌃⌥S". */
  display: string;
  /** Electron accelerator used until the Swift engine owns the fn key. */
  fallbackAccelerator: string | null;
  registered: boolean;
}

export type IpcChannel =
  | 'capture:start-voice'
  | 'capture:stop-voice'
  | 'capture:screenshot'
  | 'capture:meeting-response'
  | 'capture:stop-meeting'
  | 'capture:event'
  | 'overlay:close'
  | 'app:open-main'
  | 'app:hotkeys'
  | 'app:navigate';

/** Exposed on `window.openkt` by the preload script. Absent in a browser. */
export interface OpenKTBridge {
  platform: string;
  versions: { app: string; electron: string };
  capture: {
    startVoice(): Promise<void>;
    stopVoice(): Promise<void>;
    captureScreenshot(): Promise<void>;
    respondToMeeting(record: boolean): Promise<void>;
    stopMeeting(): Promise<void>;
    onEvent(listener: (event: CaptureEvent) => void): () => void;
  };
  overlay: {
    close(kind: OverlayKind): Promise<void>;
  };
  app: {
    /** Focus the main window, optionally at a hash route like "/sessions/abc". */
    openMain(route?: string): Promise<void>;
    hotkeys(): Promise<HotkeyInfo[]>;
    /** Main asks the main window to navigate (tray → "New voice note"). */
    onNavigate(listener: (route: string) => void): () => void;
  };
}

declare global {
  interface Window {
    openkt?: OpenKTBridge;
  }
}
