/**
 * capture — the one interface the rest of the main process uses for voice,
 * screenshots and meetings. It owns no UI and no hotkeys; it turns engine
 * traffic into `CaptureEvent`s and hands results back.
 *
 * The engine behind it is currently `StubEngine` (simulated results). A Swift
 * engine will replace it without changing this interface — see ../engine.
 */
import type { CaptureEvent } from '../../shared/ipc';
import type { Engine } from '../engine/protocol';

export interface VoiceNote {
  captureId: string;
  text: string;
  durationSec: number;
}

export interface Screenshot {
  captureId: string;
  description: string;
  visibleText: string;
}

export interface MeetingDetected {
  app: string;
  /** Call once with the user's answer. Recording never starts without `true`. */
  respond(record: boolean): Promise<void>;
}

export interface CaptureService {
  /** Begin listening. Resolves once the engine has started; partials arrive as events. */
  startVoice(opts?: { latch?: boolean }): Promise<void>;
  /** Stop listening. Resolves with the final transcript, or null if nothing was running. */
  stopVoice(): Promise<VoiceNote | null>;
  readonly isListening: boolean;
  /** Capture what is on screen and have the local vision model read it. */
  captureScreenshot(): Promise<Screenshot>;
  /** Fires when a meeting app starts using the microphone. Returns an unsubscribe. */
  onMeetingDetected(listener: (meeting: MeetingDetected) => void): () => void;
  stopMeeting(): Promise<void>;
  /** Everything above, as a flat event stream for renderer windows. */
  onEvent(listener: (event: CaptureEvent) => void): () => void;
  dispose(): Promise<void>;
}

export function createCaptureService(engine: Engine): CaptureService {
  const listeners = new Set<(e: CaptureEvent) => void>();
  const meetingListeners = new Set<(m: MeetingDetected) => void>();
  const emit = (e: CaptureEvent) => listeners.forEach((l) => l(e));
  let listening = false;
  let meetingTimer: NodeJS.Timeout | null = null;

  const offs = [
    engine.on('voice.partial', (p) =>
      emit({ type: 'voice.partial', captureId: p.captureId, text: p.text, tentative: p.tentative, elapsedSec: p.elapsedSec }),
    ),
    engine.on('meeting.detected', (p) => {
      emit({ type: 'meeting.detected', app: p.app });
      const meeting: MeetingDetected = {
        app: p.app,
        respond: async (record) => {
          await engine.recordMeeting(record);
          if (!record) return;
          const startedAt = Date.now();
          const title = 'Pricing call with Northgate';
          const tick = () => emit({ type: 'meeting.recording', title, elapsedSec: Math.round((Date.now() - startedAt) / 1000) });
          tick();
          meetingTimer = setInterval(tick, 1000);
        },
      };
      meetingListeners.forEach((l) => l(meeting));
    }),
    engine.on('meeting.stopped', (p) => emit({ type: 'meeting.stopped', title: p.title, durationSec: p.durationSec })),
  ];

  return {
    get isListening() {
      return listening;
    },

    async startVoice(opts) {
      if (listening) return;
      listening = true;
      const { captureId } = await engine.startVoice({ latch: opts?.latch ?? false });
      emit({ type: 'voice.started', captureId });
    },

    async stopVoice() {
      if (!listening) return null;
      listening = false;
      const r = await engine.stopVoice();
      if (!r) return null;
      emit({ type: 'voice.final', captureId: r.captureId, text: r.text, durationSec: r.durationSec });
      return { captureId: r.captureId, text: r.text, durationSec: r.durationSec };
    },

    async captureScreenshot() {
      const r = await engine.captureScreenshot();
      emit({ type: 'screenshot.captured', captureId: r.captureId, description: r.description, visibleText: r.visibleText });
      return { captureId: r.captureId, description: r.description, visibleText: r.visibleText };
    },

    onMeetingDetected(listener) {
      meetingListeners.add(listener);
      return () => meetingListeners.delete(listener);
    },

    async stopMeeting() {
      if (meetingTimer) clearInterval(meetingTimer);
      meetingTimer = null;
      await engine.stopMeeting();
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispose() {
      if (meetingTimer) clearInterval(meetingTimer);
      offs.forEach((off) => off());
      listeners.clear();
      meetingListeners.clear();
      await engine.stop();
    },
  };
}
