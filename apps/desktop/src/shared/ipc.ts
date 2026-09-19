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
  | 'local-ai:embed'
  | 'voice:begin'
  | 'voice:chunk'
  | 'voice:end'
  | 'voice:to-session'
  | 'voice:cancel'
  | 'screenshot:capture'
  | 'auth:google:start'
  | 'auth:google:cancel'
  // ── first run: permissions + on-device AI setup + try-it (begin) ──
  | 'permissions:status'
  | 'permissions:request'
  | 'permissions:open-settings'
  | 'permissions:watch'
  | 'permissions:changed'
  | 'permissions:relaunch'
  | 'models:setup-info'
  | 'models:pause'
  | 'models:resume'
  | 'app:start-capture'
  // ── first run (end) ──
  // ── in-app updates (main: src/main/update) ──
  | 'update:status'
  | 'update:check'
  | 'update:download'
  | 'update:install'
  | 'update:set-auto'
  | 'update:move-to-applications'
  | 'update:rollback'
  | 'update:seen'
  | 'update:event';
  // ── end in-app updates ──

// ── first run: permissions + on-device AI setup (begin) ── main: src/main/permissions, src/main/models/setup.ts
import type { PermissionKind, PermissionsStatusDto } from './permissions';
export type { PermissionKind, PermissionState, PermissionsStatusDto } from './permissions';

/** What the first-run "Set up on-device AI" screen needs before and while downloading. */
export interface ModelsSetupInfoDto {
  totalBytes: number;
  remainingBytes: number;
  /** null when free space could not be read. */
  freeBytes: number | null;
  neededBytes: number;
  enoughDisk: boolean;
  totalMemBytes: number;
  /** ≤ 8 GB of memory: the smaller models are used. */
  smallModel: boolean;
  paused: boolean;
  /** The person has chosen to download (all, or a feature's model). Nothing is fetched before that. */
  chosen: boolean;
  /** Helpers inside the app. false = missing from this build. */
  bundled: { runtime: boolean; transcriber: boolean; textReader: boolean };
}

export interface PermissionsBridge {
  status(): Promise<PermissionsStatusDto>;
  /** The right thing for the current state: the macOS prompt, or System Settings when macOS will not ask again. */
  request(kind: PermissionKind): Promise<PermissionsStatusDto>;
  openSettings(kind: PermissionKind): Promise<void>;
  /** Main polls every 1.5 s while anything is subscribed, and re-checks when the app regains focus. */
  onChange(listener: (status: PermissionsStatusDto) => void): () => void;
  /** Quit and reopen (macOS only applies a new Screen Recording answer to a fresh process). */
  relaunch(): Promise<void>;
}
// ── first run (end) ──

/** Google sign-in in the system browser (main: src/main/auth). Errors cross IPC as a tagged value, never a throw. */
export type GoogleAuthResultDto = { id_token: string } | { error: 'cancelled' | 'timeout' | 'failed'; message: string };

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

export type ModelRoleDto = 'embed' | 'llm' | 'whisper' | 'mmproj';
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
  /** The open-source model, as shown before download: its name, licence (SPDX), model card and download source. */
  name?: string;
  license?: string;
  card?: string;
  source?: string;
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
  /** True after a GPU crash made the local servers restart on the CPU (slower). */
  cpuFallback: boolean;
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

// ── Voice notes and screenshots (main: src/main/capture; see src/main/models/README.md) ──

/** `permission_denied`: macOS refused the microphone or screen recording. `not_ready`: the speech model is still downloading. */
export interface CaptureFailureDto {
  error: 'permission_denied' | 'not_ready' | 'unknown_id' | 'failed';
  message: string;
}

export interface VoiceTranscriptDto {
  empty?: false;
  /** After the code-only cleanup (English fillers, repeated words). This is the text to save. */
  text: string;
  raw_text: string;
  segments: { t0_ms: number; t1_ms: number; text: string }[];
  /** ISO 639-1 code whisper detected, e.g. "en", "th", "hi". */
  language: string;
  duration_ms: number;
  transcribe_ms: number;
  used_gpu: boolean;
  audio_path?: string;
}

/** Under 1.5 s, silence, or no words: nothing is created. */
export interface VoiceEmptyDto {
  empty: true;
  duration_ms: number;
  reason: 'too_short' | 'silence' | 'no_speech';
}

export interface VoiceSessionDto {
  title: string;
  summary: string;
  facts: { kind: string; statement: string; quote: string }[];
  status: 'ok' | 'partial' | 'noop';
}

export interface ScreenshotResultDto {
  cancelled?: true;
  /** Generic description and under 20 characters of text: nothing saved (`nothing` is the same flag). */
  nothing_to_save?: true;
  nothing?: true;
  image_path: string;
  visible_text: string;
  description: string;
  entities: string[];
  facts: { kind: string; statement: string; quote: string }[];
  title: string;
  /** "unavailable": the vision projector is not downloaded yet, so only OCR + extract ran. */
  vision: 'ok' | 'unavailable' | 'failed';
  ocr_chars: number;
  dropped_facts: { statement: string; reason: string }[];
  latency_ms: { ocr: number; resize: number; describe: number; extract: number };
  notes: string[];
}

// ── In-app updates (main: src/main/update; see apps/desktop/README.md "Updates") ──

export type UpdatePhaseDto = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';

export interface UpdateStatusDto {
  /** The running build: `0.3.<run>` from CI, `0.3.0-dev.0` from source. */
  version: string;
  commit: string;
  builtAt: string;
  channel: string;
  /** `custom`: verified self-update for ad-hoc signed builds · `signed`: electron-updater (Developer ID) · `disabled`: dev build / not macOS. */
  mode: 'custom' | 'signed' | 'disabled';
  phase: UpdatePhaseDto;
  /** "Download updates automatically" (default on). */
  auto: boolean;
  lastCheckedAt: string | null;
  /** The newer version the feed offers, once a check found one. */
  available: { version: string; notes: string[]; releasedAt: string; size: number } | null;
  progress: { receivedBytes: number; totalBytes: number; bytesPerSec: number } | null;
  /** Last failure, in words. */
  error: string | null;
  /** Where the app runs from. `ok: false` blocks installing; `canMove` → offer "Move to Applications". */
  location: { ok: boolean; message: string | null; canMove: boolean };
  /** Shown once after an update: "Updated to 0.3.128 — what's new". */
  whatsNew: { version: string; from: string; notes: string[] } | null;
  /** Two starts of this version never became healthy and the previous copy is still there. */
  rollback: { from: string; to: string } | null;
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
    /** first run: what the hotkey does, for the person whose hotkey is taken — opens the voice pill or the screenshot picker. */
    startCapture(kind: 'voice' | 'screenshot'): Promise<void>;
  };
  models: {
    status(): Promise<LocalAiStatusDto>;
    /**
     * The person's choice to download. No roles: everything missing (embeddings first); resolves when
     * embeddings + LLM are on disk. With roles (a feature asking for its model, e.g. ['whisper']):
     * those go first and it resolves when they are on disk. Safe to call repeatedly; joins a run in flight.
     */
    ensure(roles?: ModelRoleDto[]): Promise<ModelsEnsureResult>;
    onProgress(listener: (progress: ModelsProgressDto) => void): () => void;
    // ── first run (begin) ──
    setupInfo(): Promise<ModelsSetupInfoDto>;
    /** Stops the transfer and keeps what arrived. `resume()` continues the same models from there. */
    pause(): Promise<ModelsSetupInfoDto>;
    resume(): Promise<ModelsSetupInfoDto>;
    // ── first run (end) ──
  };
  // ── first run (begin) ──
  permissions: PermissionsBridge;
  // ── first run (end) ──
  localAi: {
    extractNote(input: { text: string; title?: string; date?: string; source?: string; author?: string }): Promise<ExtractedNoteDto>;
    /** Unit-norm 1024-dim vectors. kind "query" adds the retrieval instruction prefix. */
    embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
  };
  /** The renderer records (getUserMedia); main transcribes with whisper.cpp. Not streaming: text arrives from `end`. */
  voice: {
    /** Asks macOS for the microphone first. Resolves with the recording id, or `{error:'permission_denied'}`. */
    begin(): Promise<string | CaptureFailureDto>;
    /** 16 kHz mono PCM16, any chunk size. Audio past ten minutes is dropped. */
    chunk(id: string, pcm16: ArrayBuffer): Promise<{ ok: boolean; duration_ms: number }>;
    end(id: string, opts?: { language?: string; keepAudio?: boolean }): Promise<VoiceTranscriptDto | VoiceEmptyDto | CaptureFailureDto>;
    /** summarise + extract over the transcript of `id`; call once, after `end`. */
    toSession(id: string): Promise<VoiceSessionDto | CaptureFailureDto>;
    /** Drops the recording and its transcript. */
    cancel(id: string): Promise<void>;
  };
  screenshot: {
    /** `interactive`: the macOS region picker (Esc → `{cancelled:true}`). `file`: an existing image. */
    capture(opts: { mode: 'interactive' | 'file'; path?: string; caption?: string }): Promise<ScreenshotResultDto | { cancelled: true } | CaptureFailureDto>;
    /** The path of a dropped `File` (Electron removed `File.path`). */
    pathForFile(file: File): string;
  };
  net: {
    request(req: NetRequest): Promise<NetResponse>;
  };
  auth: {
    google: {
      /** Opens the system browser; resolves once Google redirects back, the person cancels, or three minutes pass. */
      start(input: { clientId: string; clientSecret?: string }): Promise<GoogleAuthResultDto>;
      cancel(): Promise<void>;
    };
  };
  /** OS-keychain-encrypted strings (the access token). */
  secureStore: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  // ── in-app updates ──
  update: {
    status(): Promise<UpdateStatusDto>;
    /** Asks the feed now. Downloads in the background when "automatically" is on. */
    check(): Promise<UpdateStatusDto>;
    download(): Promise<UpdateStatusDto>;
    /** Quits, swaps the bundle and relaunches. Resolves only if it could not start. */
    install(): Promise<UpdateStatusDto>;
    setAuto(on: boolean): Promise<UpdateStatusDto>;
    /** Moves the app to /Applications and relaunches it (Electron's moveToApplicationsFolder). */
    moveToApplications(): Promise<UpdateStatusDto>;
    /** "Go back to the previous version". */
    rollback(): Promise<UpdateStatusDto>;
    /** The "what's new" note has been seen. */
    seen(): Promise<UpdateStatusDto>;
    onEvent(listener: (status: UpdateStatusDto) => void): () => void;
  };
  // ── end in-app updates ──
}

declare global {
  interface Window {
    openkt?: OpenKTBridge;
  }
}
