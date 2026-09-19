import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../../api';
import { CaptureError, screenshot, type ScreenshotResult } from '../../api/bridge';
import { useClient } from '../../api/hooks';
import { fileCapture, modelsPending } from '../../capture/save';
import { useSaveSpace } from '../../components/useSaveSpace';
import { EXTRACT_LATER } from './VoiceCapture';
import { ScreenshotSheet } from './parts';

type Captured = Extract<ScreenshotResult, { outcome: 'captured' }>;

export interface ScreenshotCaptureProps {
  /** `interactive`: the macOS region picker. `file`: an image dropped on the window. */
  request: { mode: 'interactive' } | { mode: 'file'; path: string };
  onClose: () => void;
  lingerMs?: number;
}

const SCREEN_BLOCKED = 'OpenKT cannot record the screen. Allow it in System Settings → Privacy & Security → Screen Recording.';

/** Spec 03 §4: caption if typed, the description, then the text that was in the image. */
export function screenshotTurns(shot: Pick<Captured, 'description' | 'visibleText'>, caption: string): string[] {
  return [caption.trim(), shot.description.trim(), shot.visibleText.trim() ? `Text in image: ${shot.visibleText.trim()}` : ''].filter(Boolean);
}

const fileUrl = (path: string) => (path ? (/^(file|data|blob):/.test(path) ? path : `file://${path.split('/').map(encodeURIComponent).join('/')}`) : '');

/** Capture-Screenshot.dc.html, wired: capture → read on this Mac → title line, space, Save. */
export function ScreenshotCapture({ request, onClose, lingerMs = 1400 }: ScreenshotCaptureProps) {
  const client = useClient();
  const { spaceId, setSpaceId, space, options, remember } = useSaveSpace();
  const [shot, setShot] = useState<Captured | null>(null);
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<'reading' | 'ready' | 'nothing' | 'saving' | 'saved' | 'failed'>('reading');
  const [note, setNote] = useState<string>();
  const closed = useRef(false);
  const path = request.mode === 'file' ? request.path : undefined;

  const close = useCallback(
    (afterMs = 0) => {
      if (closed.current) return;
      closed.current = true;
      setTimeout(onClose, afterMs);
    },
    [onClose],
  );

  useEffect(() => {
    let live = true;
    screenshot.capture(path ? { mode: 'file', path } : { mode: 'interactive' }).then(
      (r) => {
        if (!live) return;
        if (r.outcome === 'cancelled') return close(); // the person pressed esc in the picker: say nothing
        if (r.outcome === 'nothing') {
          setPhase('nothing');
          return setNote('nothing saved');
        }
        setShot(r);
        setTitle(r.title || r.description);
        setPhase('ready');
      },
      (e: unknown) => {
        if (!live) return;
        setPhase('failed');
        setNote(e instanceof CaptureError && e.kind === 'permission' ? SCREEN_BLOCKED : describeError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [path, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const save = async () => {
    if (phase === 'nothing' || phase === 'failed') return close();
    if (!shot || !spaceId || phase !== 'ready') return;
    setPhase('saving');
    setNote('filing…');
    try {
      const later = shot.facts.length === 0 && (await modelsPending());
      // The title line is the person's own words once they change it: that is the caption turn.
      const caption = title.trim() !== (shot.title || shot.description).trim() ? title : '';
      await fileCapture(client, { source: 'screenshot', title, summary: shot.description, spaceId, turns: screenshotTurns(shot, caption), facts: shot.facts, extractLater: later });
      remember();
      setPhase('saved');
      setNote(later ? EXTRACT_LATER : 'saved');
      close(later && lingerMs ? lingerMs + 1600 : lingerMs); // longer, so the line about the models can be read
    } catch (e) {
      setPhase('ready');
      setNote(describeError(e));
    }
  };

  const nothing = phase === 'nothing' || phase === 'failed';
  return (
    <ScreenshotSheet
      description={phase === 'nothing' ? 'Nothing worth saving here — too little text, and nothing to say about the picture.' : phase === 'failed' ? 'The screenshot could not be read.' : title}
      onDescription={setTitle}
      reading={phase === 'reading'}
      saving={phase === 'saving' || phase === 'saved'}
      nothing={nothing}
      image={fileUrl(shot?.imagePath ?? '')}
      note={note}
      spaceId={spaceId}
      onSpace={setSpaceId}
      spaces={options}
      spaceLabel={space ? (space.personal ? 'Personal' : space.name) : undefined}
      onSave={() => void save()}
    />
  );
}
