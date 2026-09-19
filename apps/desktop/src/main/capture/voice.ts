/**
 * Voice notes (Spec 03 §3, interim runtime §1a). The renderer owns the microphone and streams
 * 16 kHz mono PCM16; this module owns everything after: WAV → whisper-cli → code-only cleanup →
 * summarise + extract. No `electron` import — CI drives this same class outside Electron.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanTranscript, type Segment } from './transcript';
import { durationMs, encodeWav, rmsLevel, SAMPLE_RATE } from './wav';
import type { Whisper } from './whisper';

export const MIN_CLIP_MS = 1500;
export const MAX_CLIP_MS = 10 * 60_000;
/** Below this the clip is digital silence or room hiss; whisper would only hallucinate on it. */
export const SILENCE_RMS = 0.0015;
const SESSION_TTL_MS = 30 * 60_000;

export type CaptureErrorCode = 'permission_denied' | 'not_ready' | 'unknown_id' | 'failed';
export interface CaptureFailure { error: CaptureErrorCode; message: string }

export interface VoiceTranscript {
  empty?: false;
  text: string;
  /** Before the filler/repeat cleanup. */
  raw_text: string;
  segments: Segment[];
  language: string;
  duration_ms: number;
  transcribe_ms: number;
  used_gpu: boolean;
  /** Only with `keepAudio`. */
  audio_path?: string;
}
export type VoiceEndResult = VoiceTranscript | { empty: true; duration_ms: number; reason: 'too_short' | 'silence' | 'no_speech' } | CaptureFailure;

export interface VoiceNoteSession { title: string; summary: string; facts: { kind: string; statement: string; quote: string }[]; status: 'ok' | 'partial' | 'noop' }

export interface VoiceDeps {
  whisper: Whisper;
  /** Resolves false when the speech model is not on disk yet. */
  modelReady(): Promise<boolean>;
  tmpDir: string;
  /** `systemPreferences.askForMediaAccess('microphone')` in the app. */
  askMicrophone?: () => Promise<boolean>;
  /** The existing summarise + extract path, on one turn {role:'user', content:text}. */
  toNote(text: string): Promise<VoiceNoteSession>;
}

interface Recording { chunks: Buffer[]; bytes: number; text: string | null; timer: NodeJS.Timeout }

const MIC_DENIED = 'OpenKT cannot use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.';

export function toBuffer(chunk: unknown): Buffer | null {
  if (Buffer.isBuffer(chunk)) return chunk;
  // By tag, not instanceof: an ArrayBuffer from another realm is still an ArrayBuffer.
  if (Object.prototype.toString.call(chunk) === '[object ArrayBuffer]') return Buffer.from(chunk as ArrayBuffer);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

export class VoiceService {
  private readonly recordings = new Map<string, Recording>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: VoiceDeps) {}

  get activeCount(): number {
    return this.recordings.size;
  }

  async begin(): Promise<string | CaptureFailure> {
    if (this.deps.askMicrophone && !(await this.deps.askMicrophone().catch(() => false))) return { error: 'permission_denied', message: MIC_DENIED };
    const id = randomUUID();
    const timer = setTimeout(() => this.recordings.delete(id), SESSION_TTL_MS + MAX_CLIP_MS);
    timer.unref();
    this.recordings.set(id, { chunks: [], bytes: 0, text: null, timer });
    return id;
  }

  /** Audio past ten minutes is dropped (Spec 03 §3: auto-stop). Returns the clip length so far. */
  chunk(id: string, data: unknown): { ok: boolean; duration_ms: number } {
    const rec = this.recordings.get(id);
    const buf = toBuffer(data);
    if (!rec || !buf || rec.text !== null) return { ok: false, duration_ms: rec ? durationMs(rec.bytes) : 0 };
    if (durationMs(rec.bytes + buf.length) <= MAX_CLIP_MS) {
      rec.chunks.push(Buffer.from(buf)); // copy: the IPC buffer may be reused
      rec.bytes += buf.length;
    }
    return { ok: true, duration_ms: durationMs(rec.bytes) };
  }

  async end(id: string, opts: { language?: string; keepAudio?: boolean } = {}): Promise<VoiceEndResult> {
    const rec = this.recordings.get(id);
    if (!rec) return { error: 'unknown_id', message: `no voice recording "${id}"` };
    const pcm = Buffer.concat(rec.chunks);
    rec.chunks = [];
    const duration = durationMs(pcm.length);
    const nothing = (reason: 'too_short' | 'silence' | 'no_speech') => {
      this.forget(id);
      return { empty: true as const, duration_ms: duration, reason };
    };
    if (duration < MIN_CLIP_MS) return nothing('too_short');
    if (rmsLevel(pcm) < SILENCE_RMS) return nothing('silence');
    if (!(await this.deps.modelReady())) {
      this.forget(id);
      return { error: 'not_ready', message: 'The speech model is still downloading.' };
    }
    const language = typeof opts.language === 'string' && /^[a-z]{2,3}$/.test(opts.language) ? opts.language : 'auto';
    const wav = join(this.deps.tmpDir, `${id}.wav`);
    // One transcription at a time: whisper uses every core it is given.
    const job = this.queue.then(async () => {
      await mkdir(this.deps.tmpDir, { recursive: true });
      await writeFile(wav, encodeWav(pcm, SAMPLE_RATE), { mode: 0o600 });
      try {
        return await this.deps.whisper.transcribe(wav, language, duration);
      } finally {
        if (!opts.keepAudio) await rm(wav, { force: true });
      }
    });
    this.queue = job.catch(() => undefined);
    let run;
    try {
      run = await job;
    } catch (e) {
      this.forget(id);
      return { error: 'failed', message: (e as Error).message };
    }
    const text = cleanTranscript(run.text, run.language);
    if (!text.trim()) {
      if (opts.keepAudio) await rm(wav, { force: true });
      return nothing('no_speech');
    }
    rec.text = text;
    return {
      text,
      raw_text: run.text,
      segments: run.segments,
      language: run.language,
      duration_ms: duration,
      transcribe_ms: run.latencyMs,
      used_gpu: run.usedGpu,
      ...(opts.keepAudio ? { audio_path: wav } : {}),
    };
  }

  /** `{title, summary, facts}` for the transcript of `id`. The transcript is forgotten afterwards. */
  async toSession(id: string): Promise<VoiceNoteSession | CaptureFailure> {
    const rec = this.recordings.get(id);
    if (!rec || rec.text === null) return { error: 'unknown_id', message: `no transcript for "${id}"` };
    try {
      return await this.deps.toNote(rec.text);
    } catch (e) {
      return { error: 'failed', message: (e as Error).message };
    } finally {
      this.forget(id);
    }
  }

  cancel(id: string): void {
    this.forget(id);
  }

  private forget(id: string): void {
    const rec = this.recordings.get(id);
    if (rec) clearTimeout(rec.timer);
    this.recordings.delete(id);
  }
}
