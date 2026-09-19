import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../../api';
import { CaptureError, voice } from '../../api/bridge';
import { useClient } from '../../api/hooks';
import { RecorderError, startRecorder as realRecorder, type Recorder, type StartRecorder } from '../../capture/recorder';
import { modelsSetup } from '../../api/setup-bridge';
import { fileCapture, modelsPending } from '../../capture/save';
import { useSaveSpace } from '../../components/useSaveSpace';
import { finishingSetup, formatBytes, plainError, rowPercent, speechReadiness, type SpeechReadiness } from '../../onboarding/models';
import { VoiceSheet, type VoiceState } from './parts';

const LEVELS = 14;
const MIC_BLOCKED = 'OpenKT cannot use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.';
/** Saved without facts: they are pulled out on this Mac once the on-device AI is there (downloading, or not chosen yet). */
export const EXTRACT_LATER = 'Saved. Its key points are pulled out on this Mac once the on-device AI is there (Settings → Models).';
/** The speech model is on its way: say how far along the setup is instead of failing. */
export const speechSetupNotice = (pct: number) => `${finishingSetup(pct)}. Voice notes work as soon as the speech model is on this Mac.`;
/** The speech model is not on this Mac and nothing is downloading: say so, and offer it right here. */
export const speechNeededNotice = (bytes: number) => `Voice needs the speech model (${formatBytes(bytes)}). It is downloaded once and runs on this Mac — nothing is sent to a cloud model.`;
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
  const { spaceId, setSpaceId, space, options, remember } = useSaveSpace();
  const [state, setState] = useState<VoiceState>('listening');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array<number>(LEVELS).fill(0));
  const [offer, setOffer] = useState<{ label: string; onClick: () => void; disabled?: boolean } | undefined>(undefined);

  const session = useRef<{ id: string; rec: Recorder | null; startedAt: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const closed = useRef(false);

  const close = useCallback(
    (afterMs = 0) => {
      if (closed.current) return;
      closed.current = true;
      setTimeout(onClose, afterMs);
    },
    [onClose],
  );

  // ── speech not on this Mac yet ── on its way: how far along. Not chosen: offer just the speech model, here.
  const offRef = useRef<() => void>(() => undefined);
  useEffect(() => () => offRef.current(), []);
  const needSpeech = useCallback((speech: SpeechReadiness) => {
    setState('setup');
    if (speech.downloading) {
      setOffer(undefined);
      return setNotice(speechSetupNotice(speech.percent));
    }
    const fetchSpeech = async () => {
      setOffer({ label: 'Downloading…', onClick: () => undefined, disabled: true });
      setNotice('Downloading the speech model to this Mac…');
      offRef.current();
      offRef.current = modelsSetup.onProgress((r) => r.role === 'whisper' && r.state === 'downloading' && setNotice(`Downloading the speech model — ${rowPercent(r)}%`));
      const err = await modelsSetup.ensure(['whisper']);
      offRef.current();
      if (!err) {
        setOffer(undefined);
        return setNotice('The speech model is on this Mac. Press ⌃⌥Space to talk.');
      }
      setNotice(err === 'low_disk' ? 'There is not enough space on this Mac for the speech model.' : err === 'paused' ? 'The download is paused (Settings → Models).' : plainError(err));
      setOffer({ label: 'Try again', onClick: () => void fetchSpeech() });
    };
    setNotice(speechNeededNotice(speech.speechBytes));
    setOffer({ label: `Download the speech model (${formatBytes(speech.speechBytes)})`, onClick: () => void fetchSpeech() });
  }, []);

  const fail = useCallback((e: unknown) => {
    if (notReady(e)) {
      void speechReadiness().then(needSpeech);
      return;
    }
    const permission = (e instanceof RecorderError || e instanceof CaptureError) && e.kind === 'permission';
    setState(permission ? 'permission' : 'failed');
    setNotice(permission ? MIC_BLOCKED : e instanceof RecorderError && e.kind === 'no-microphone' ? 'No microphone was found on this Mac.' : describeError(e));
  }, [needSpeech]);

  // Start as soon as the pill is on screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Nothing to record into while the speech model is still downloading.
        const speech = await speechReadiness();
        if (cancelled) return;
        if (!speech.ready) return needSpeech(speech);
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
  }, [recorder, fail, needSpeech]);

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
      remember();
      setNotice(later ? EXTRACT_LATER : '');
      setState('saved');
      close(later && lingerMs ? lingerMs + 1600 : lingerMs); // longer, so the line about the models can be read
    } catch (e) {
      setNotice(describeError(e));
      setState('review');
    }
  }, [client, close, lingerMs, spaceId, text, remember]);

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

  return (
    <div onDoubleClick={() => void stop()} style={{ display: 'contents' }}>
      <VoiceSheet
        text={text}
        tentative=""
        elapsedSec={elapsed}
        state={state}
        hint="⌃⌥Space or ⌃⌥N again to stop"
        levels={state === 'listening' ? levels : undefined}
        spaceId={spaceId}
        onSpace={setSpaceId}
        spaces={options}
        spaceLabel={space ? (space.personal ? 'Personal' : space.name) : undefined}
        accessNote={space ? (space.personal ? 'private' : 'shared space') : ''}
        notice={notice}
        action={state === 'setup' ? offer : undefined}
        onSave={() => void save()}
      />
    </div>
  );
}
