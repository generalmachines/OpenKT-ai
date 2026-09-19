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
  | 'app:navigate'
  | 'net:request'
  | 'secure:get'
  | 'secure:set'
  | 'secure:delete'
  | 'models:status'
  | 'models:ensure'
  | 'models:progress'
  | 'local-ai:extract-note'
  | 'local-ai:embed';

/** A server request made by main for the renderer (file:// origins fail the server's CORS allowlist). */
export interface NetRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

export interface NetResponse {
  status: number;
  body: string;
}

// ── Local models (main: src/main/models + src/main/local-ai; see src/main/models/README.md) ──

export type ModelRoleDto = 'embed' | 'llm' | 'mmproj';
export type ModelStateDto = 'missing' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';

export interface ModelStatusDto {
  role: ModelRoleDto;
  id: string;
  file: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: ModelStateDto;
  error?: string;
}

/** Pushed at most 4×/s per file while downloading, plus one final event per file. */
export interface ModelsProgressDto {
  role: ModelRoleDto;
  id: string;
  file: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSec: number;
  /** 0..1 across all files of the current ensure() call. */
  overall: number;
  state: ModelStateDto;
  error?: string;
}

export interface LocalServerInfoDto {
  state: 'stopped' | 'starting' | 'ready' | 'crashed' | 'failed';
  port: number;
  pid: number | null;
  restarts: number;
  lastError: string | null;
}

export interface LocalAiStatusDto {
  runtime: 'llama.cpp';
  binary: string;
  binaryFound: boolean;
  /** "llm-4b" or "llm-2b" (Macs with ≤ 8 GB RAM). */
  tier: string;
  models: ModelStatusDto[];
  servers: { chat: LocalServerInfoDto; embed: LocalServerInfoDto };
}

export type ModelsEnsureResult = { ok: true; status: LocalAiStatusDto } | { ok: false; error: string; status: LocalAiStatusDto };

export interface ExtractedNoteDto {
  title: string;
  summary: string;
  facts: { kind: string; statement: string; quote: string }[];
  status: 'ok' | 'partial' | 'noop';
  latencyMs: { summarise: number; extract: number };
  notes: string[];
}

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
  models: {
    status(): Promise<LocalAiStatusDto>;
    /** Downloads whatever is missing (embeddings first). Resolves when embeddings + LLM are on disk. Safe to call repeatedly. */
    ensure(): Promise<ModelsEnsureResult>;
    onProgress(listener: (progress: ModelsProgressDto) => void): () => void;
  };
  localAi: {
    extractNote(input: { text: string; title?: string; date?: string; source?: string; author?: string }): Promise<ExtractedNoteDto>;
    /** Unit-norm 1024-dim vectors. kind "query" adds the retrieval instruction prefix. */
    embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
  };
  net: {
    request(req: NetRequest): Promise<NetResponse>;
  };
  /** OS-keychain-encrypted strings (the access token). */
  secureStore: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

declare global {
  interface Window {
    openkt?: OpenKTBridge;
  }
}
