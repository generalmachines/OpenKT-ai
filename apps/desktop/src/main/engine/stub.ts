/**
 * StubEngine — simulates the Swift engine so the rest of the app can be built
 * and exercised. No audio is captured, no screen is read, no model runs.
 * Timings and text are canned (taken from the capture artboards).
 */
import { EventEmitter } from 'node:events';
import {
  ENGINE_PROTOCOL_VERSION,
  type Engine,
  type EngineEvent,
  type EngineEventName,
  type ScreenshotResult,
  type VoiceResult,
} from './protocol';

const VOICE_SCRIPT =
  'What if every new store got an onboarding kit — a printed shelf map, the first week’s planogram, and a QR code to the floor plan. The first week should feel finished, not half set up.';

export class StubEngine implements Engine {
  private readonly bus = new EventEmitter();
  private seq = 0;
  private voice: { captureId: string; startedAt: number; timer: NodeJS.Timeout; words: number } | null = null;
  private meeting: { title: string; startedAt: number } | null = null;

  async start(): Promise<void> {
    this.emit({ event: 'ready', protocol: ENGINE_PROTOCOL_VERSION, engineVersion: 'stub' });
  }

  async stop(): Promise<void> {
    if (this.voice) clearInterval(this.voice.timer);
    this.voice = null;
    this.meeting = null;
    this.bus.removeAllListeners();
  }

  async startVoice(_opts: { latch: boolean }): Promise<{ captureId: string }> {
    if (this.voice) return { captureId: this.voice.captureId };
    const captureId = `voice-${++this.seq}`;
    const words = VOICE_SCRIPT.split(' ');
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const v = this.voice;
      if (!v) return;
      v.words = Math.min(words.length, v.words + 2);
      const stable = Math.max(0, v.words - 5);
      this.emit({
        event: 'voice.partial',
        captureId,
        text: words.slice(0, stable).join(' '),
        tentative: words.slice(stable, v.words).join(' '),
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }, 350);
    this.voice = { captureId, startedAt, timer, words: 0 };
    return { captureId };
  }

  async stopVoice(): Promise<VoiceResult | null> {
    const v = this.voice;
    if (!v) return null;
    clearInterval(v.timer);
    this.voice = null;
    const text = VOICE_SCRIPT.split(' ').slice(0, Math.max(v.words, 6)).join(' ');
    const result: VoiceResult = {
      event: 'voice.final',
      captureId: v.captureId,
      text,
      durationSec: Math.max(1, Math.round((Date.now() - v.startedAt) / 1000)),
      language: 'en',
    };
    this.emit(result);
    return result;
  }

  async captureScreenshot(): Promise<ScreenshotResult> {
    await new Promise((r) => setTimeout(r, 400));
    const result: ScreenshotResult = {
      event: 'screenshot.result',
      captureId: `shot-${++this.seq}`,
      imagePath: '',
      description: 'Competitor pricing page — three tiers, per-store billing on the top tier',
      visibleText: 'Starter · Growth · Enterprise. Enterprise: billed per store, unlimited seats.',
      entities: ['pricing', 'per-store billing'],
    };
    this.emit(result);
    return result;
  }

  /** Test hook for the stub only: pretend a meeting app grabbed the mic. */
  simulateMeetingDetected(app = 'Google Meet'): void {
    this.emit({ event: 'meeting.detected', app, pid: 0 });
  }

  async recordMeeting(accept: boolean): Promise<void> {
    this.meeting = accept ? { title: 'Pricing call with Northgate', startedAt: Date.now() } : null;
  }

  async stopMeeting(): Promise<void> {
    const m = this.meeting;
    if (!m) return;
    this.meeting = null;
    this.emit({ event: 'meeting.stopped', title: m.title, durationSec: Math.round((Date.now() - m.startedAt) / 1000) });
  }

  on<E extends EngineEventName>(event: E, listener: (payload: Extract<EngineEvent, { event: E }>) => void): () => void {
    this.bus.on(event, listener);
    return () => this.bus.off(event, listener);
  }

  private emit(e: EngineEvent): void {
    this.bus.emit(e.event, e);
  }
}
