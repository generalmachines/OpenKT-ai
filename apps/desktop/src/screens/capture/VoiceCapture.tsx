import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../../api';
import { CaptureError, voice } from '../../api/bridge';
import { useClient, useQuery } from '../../api/hooks';
import { RecorderError, startRecorder as realRecorder, type Recorder, type StartRecorder } from '../../capture/recorder';
import { fileCapture, modelsPending } from '../../capture/save';
import { finishingSetup, speechReadiness } from '../../onboarding/models';
import { VoiceSheet, type VoiceState } from './parts';

const LEVELS = 14;
const MIC_BLOCKED = 'OpenKT cannot use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.';
export const EXTRACT_LATER = 'Context will be extracted when the models finish downloading.';
/** The speech model is not on this Mac yet: say how far along the setup is instead of failing. */
export const speechSetupNotice = (pct: number) => `${finishingSetup(pct)}. Voice notes work as soon as the speech model is on this Mac.`;
const notReady = (e: unknown) => e instanceof CaptureError && /not_ready|still downloading/i.test(e.message);

export interface VoiceCaptureProps {
  /** Closes the overlay window. */
  onClose: () => void;
  /** Subscribe to "the hotkey was pressed again". Returns an unsubscribe. */
  onToggle?: (listener: () => void) => () => void;
  /** Injected in tests; the real microphone otherwise. */
  recorder?: StartRecorder;
  /** How long the final state stays up before the window closes. */
  lingerMs?: number;
}

/**
 * The voice pill, for real: microphone → 16 kHz PCM16 → `voice.chunk` while
 * listening, `voice.end` on release, then the transcript with a space picker
 * and Save. whisper is not streaming, so there is no partial text: the pill
 * says "listening · 0:14", then "transcribing…", then shows the words.
 */
export function VoiceCapture({ onClose, onToggle, recorder = realRecorder, lingerMs = 1400 }: VoiceCaptureProps) {
  const client = useClient();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const [state, setState] = useState<VoiceState>('listening');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array<number>(LEVELS).fill(0));
  const [spaceId, setSpaceId] = useState('');

  const session = useRef<{ id: string; rec: Recorder | null; startedAt: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const closed = useRef(false);

  useEffect(() => {
    if (!spaceId && spaces.data?.length) setSpaceId((spaces.data.find((s) => s.personal) ?? spaces.data[0]!).id);
  }, [spaceId, spaces.data]);

  const close = useCallback(
    (afterMs = 0) => {
      if (closed.current) return;
      closed.current = true;
      setTimeout(onClose, afterMs);
    },
    [onClose],
  );

  const fail = useCallback((e: unknown) => {
    if (notReady(e)) {
      setState('setup');
      void speechReadiness().then((s) => setNotice(speechSetupNotice(s.percent)));
      return;
    }
    const permission = (e instanceof RecorderError || e instanceof CaptureError) && e.kind === 'permission';
    setState(permission ? 'permission' : 'failed');
    setNotice(permission ? MIC_BLOCKED : e instanceof RecorderError && e.kind === 'no-microphone' ? 'No microphone was found on this Mac.' : describeError(e));
  }, []);

  // Start as soon as the pill is on screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Nothing to record into while the speech model is still downloading.
        const speech = await speechReadiness();
        if (cancelled) return;
        if (!speech.ready) {
          setState('setup');
          setNotice(speechSetupNotice(speech.percent));
          return;
        }
        const id = await voice.begin();
        if (cancelled) return voice.cancel(id);
        session.current = { id, rec: null, startedAt: Date.now() };
        const rec = await recorder({
          onChunk: (pcm) => voice.chunk(id, pcm),
          onLevel: (l) => setLevels((prev) => [...prev.slice(1), l]),
        });
        if (cancelled || !session.current) {
          rec.cancel();
          return voice.cancel(id);
        }
        session.current.rec = rec;
      } catch (e) {
        if (session.current) voice.cancel(session.current.id);
        session.current = null;
        if (!cancelled) fail(e);
      }
    })();
    return () => {
      cancelled = true;
      const s = session.current;
      session.current = null;
      s?.rec?.cancel();
    };
  }, [recorder, fail]);

  useEffect(() => {
    if (state !== 'listening') return;
    const t = setInterval(() => session.current && setElapsed(Math.floor((Date.now() - session.current.startedAt) / 1000)), 250);
    return () => clearInterval(t);
  }, [state]);

  const stop = useCallback(async () => {
    const s = session.current;
    if (stateRef.current !== 'listening' || !s?.rec) return;
    setState('transcribing');
    setElapsed(Math.round((Date.now() - s.startedAt) / 1000));
    try {
      await s.rec.stop();
      const result = await voice.end(s.id);
      if (result.empty) {
        setState('empty');
        setNotice('Nothing was said, so nothing was saved.');
        return close(lingerMs + 400);
      }
      setText(result.text);
      if (result.durationMs) setElapsed(Math.round(result.durationMs / 1000));
      setState('review');
    } catch (e) {
      fail(e);
    }
  }, [close, fail, lingerMs]);

  const discard = useCallback(() => {
    const s = session.current;
    session.current = null;
    s?.rec?.cancel();
    if (s) voice.cancel(s.id);
    close();
  }, [close]);

  const save = useCallback(async () => {
    const s = session.current;
    if (stateRef.current !== 'review' || !s || !spaceId) return;
    setState('saving');
    try {
      const later = await modelsPending();
      const note = later ? null : await voice.toSession(s.id);
      await fileCapture(client, { source: 'voice', title: note?.title ?? '', summary: note?.summary, spaceId, turns: [text], facts: note?.facts ?? [], extractLater: later });
      setNotice(later ? EXTRACT_LATER : '');
      setState('saved');
      close(later && lingerMs ? lingerMs + 1600 : lingerMs); // longer, so the line about the models can be read
    } catch (e) {
      setNotice(describeError(e));
      setState('review');
    }
  }, [client, close, lingerMs, spaceId, text]);

  // The hotkey toggles: listening → stop; with a transcript on screen → save.
  useEffect(() => onToggle?.(() => void (stateRef.current === 'listening' ? stop() : stateRef.current === 'review' ? save() : undefined)), [onToggle, stop, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        discard();
      } else if (e.key === 'Enter' && stateRef.current === 'review' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [discard, save]);

  const space = spaces.data?.find((x) => x.id === spaceId);
  return (
    <div onDoubleClick={() => void stop()} style={{ display: 'contents' }}>
      <VoiceSheet
        text={text}
        tentative=""
        elapsedSec={elapsed}
        state={state}
        hint="⌃⌥space to stop"
        levels={state === 'listening' ? levels : undefined}
        spaceId={spaceId}
        onSpace={setSpaceId}
        spaces={(spaces.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
        accessNote={space ? (space.personal ? 'private' : 'shared space') : ''}
        notice={notice}
        onSave={() => void save()}
      />
    </div>
  );
}
