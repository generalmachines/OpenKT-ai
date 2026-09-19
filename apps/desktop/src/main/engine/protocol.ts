/**
 * Engine protocol — the seam between Electron and the Swift capture engine.
 *
 * STATUS: planned. Nothing here talks to a real process yet; `StubEngine`
 * (./stub.ts) implements the same interface with simulated results.
 * See ./README.md for the transport and lifecycle.
 *
 * Wire format: newline-delimited JSON (one object per line, UTF-8) over the
 * helper's stdin/stdout. Requests carry an `id`; the engine answers with a
 * response of the same `id`; events have no `id`. The same messages are
 * intended to be carried over XPC later without changing their shape.
 */

export const ENGINE_PROTOCOL_VERSION = 1;

export type EngineRequest =
  | { id: number; method: 'hello'; params: { protocol: number } }
  | { id: number; method: 'voice.start'; params: { latch: boolean } }
  | { id: number; method: 'voice.stop'; params: Record<string, never> }
  | { id: number; method: 'screenshot.capture'; params: { mode: 'region' | 'window' | 'screen' } }
  | { id: number; method: 'meeting.record'; params: { accept: boolean } }
  | { id: number; method: 'meeting.stop'; params: Record<string, never> }
  | { id: number; method: 'hotkeys.set'; params: { voice: string; screenshot: string } }
  | { id: number; method: 'models.status'; params: Record<string, never> };

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

export type EngineEvent =
  | { event: 'ready'; protocol: number; engineVersion: string }
  | { event: 'hotkey'; key: 'voice.down' | 'voice.up' | 'voice.latch' | 'screenshot' }
  | { event: 'voice.partial'; captureId: string; text: string; tentative: string; elapsedSec: number }
  | { event: 'voice.final'; captureId: string; text: string; durationSec: number; language: string }
  | { event: 'screenshot.result'; captureId: string; imagePath: string; description: string; visibleText: string; entities: string[] }
  | { event: 'meeting.detected'; app: string; pid: number }
  | { event: 'meeting.segment'; speaker: string; at: number; text: string }
  | { event: 'meeting.stopped'; title: string; durationSec: number }
  | { event: 'model.progress'; job: string; model: string; percent: number }
  | { event: 'error'; code: string; message: string };

export type EngineEventName = EngineEvent['event'];

export type VoiceResult = Extract<EngineEvent, { event: 'voice.final' }>;
export type ScreenshotResult = Extract<EngineEvent, { event: 'screenshot.result' }>;

/**
 * What the capture module needs from an engine. `StubEngine` implements it
 * today; `SwiftEngine` (a child-process client speaking the messages above)
 * will implement it later. Nothing above this interface should change.
 */
export interface Engine {
  start(): Promise<void>;
  stop(): Promise<void>;
  startVoice(opts: { latch: boolean }): Promise<{ captureId: string }>;
  stopVoice(): Promise<VoiceResult | null>;
  captureScreenshot(): Promise<ScreenshotResult>;
  recordMeeting(accept: boolean): Promise<void>;
  stopMeeting(): Promise<void>;
  on<E extends EngineEventName>(event: E, listener: (payload: Extract<EngineEvent, { event: E }>) => void): () => void;
}
