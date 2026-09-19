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
  | 'screenshot:capture';

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
