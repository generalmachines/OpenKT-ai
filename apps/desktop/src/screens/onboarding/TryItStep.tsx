import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { describeError } from '../../api';
import { localAi } from '../../api/bridge';
import { useClient, useQuery } from '../../api/hooks';
import { captureAvailable, hotkeysTaken, startCapture } from '../../api/setup-bridge';
import { CAPTURE_SIGNAL, fileCapture, localAiReady } from '../../capture/save';
import { Key } from '../../components/bits';
import { Icon, type IconName } from '../../components/Icon';
import { usePermissions } from '../../components/PermissionsList';
import { finishingSetup, formatBytes, rowPercent, rowRemaining, type ModelsSetupState } from '../../onboarding/models';
import { markTried, readProgress, type TryItCard } from '../../onboarding/state';
import { actionFor } from '../../shared/permissions';

interface CardProps {
  icon: IconName;
  title: string;
  how: string;
  keys?: ReactNode;
  done: string | null;
  /** One calm line: why it cannot run yet, or what happened. */
  status?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean; dark?: boolean };
  children?: ReactNode;
}

function TryCard({ icon, title, how, keys, done, status, action, children }: CardProps) {
  return (
    <li className={`tryit${done !== null ? ' tryit--done' : ''}`} aria-label={title}>
      <div className="tryit__row">
        <span className="tool__icon">
          <Icon name={icon} size={18} />
        </span>
        <span className="person__text">
          <span className="person__name">{title}</span>
          <span className="person__sub tryit__how">{done !== null ? (done ? `Saved — “${done}”` : 'Saved.') : how}</span>
          {status && done === null && (
            <span className="mono small-meta tryit__status" role="status">
              {status}
            </span>
          )}
        </span>
        {keys && done === null && <span className="keys tryit__keys">{keys}</span>}
        {done !== null ? (
          <span className="conn__state mono tryit__done">
            <Icon name="check" size={13} />
            done
          </span>
        ) : (
          action && (
            <button type="button" className={`btn btn--box-sm${action.dark === false ? '' : ' btn--dark'}`} disabled={action.disabled} onClick={action.onClick}>
              {action.label}
            </button>
          )
        )}
      </div>
      {children}
    </li>
  );
}

const VOICE_KEYS = (
  <>
    <Key>⌃</Key>
    <Key>⌥</Key>
    <Key>Space</Key>
  </>
);
const SHOT_KEYS = (
  <>
    <Key>⌃</Key>
    <Key>⌥</Key>
    <Key>S</Key>
  </>
);

/**
 * Step 5: three cards that really run. A card is done only when a session of its kind was
 * actually saved after this screen opened — a voice note or a screenshot filed from the
 * overlay window (heard through the capture signal), or the note written right here.
 */
export function TryItStep({ setup, onFinish }: { setup: ModelsSetupState; onFinish: (tried: number) => void }) {
  const client = useClient();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const { status: perms, request, openSettings, relaunch } = usePermissions();
  const [tried, setTried] = useState<TryItCard[]>(() => readProgress()?.tried ?? []);
  const [titles, setTitles] = useState<Partial<Record<TryItCard, string>>>({});
  const [waiting, setWaiting] = useState<TryItCard | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const desktop = captureAvailable();

  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState('');

  const done = useCallback((card: TryItCard, title: string) => {
    setTried(markTried(card).tried);
    setTitles((t) => ({ ...t, [card]: title }));
    setWaiting((w) => (w === card ? null : w));
  }, []);

  useEffect(() => void hotkeysTaken().then(setTaken), []);

  // What was already there when the screen opened; anything new of the right kind counts.
  const baseline = useRef<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    client.listSessions({ mine: true }).then(
      (list) => live && (baseline.current = new Set(list.map((s) => s.id))),
      () => live && (baseline.current = new Set()),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const look = useCallback(async () => {
    const base = baseline.current;
    if (!base) return;
    let list;
    try {
      list = await client.listSessions({ mine: true });
    } catch {
      return; // offline for a moment: the next signal tries again
    }
    for (const s of list) {
      if (base.has(s.id) || (s.source !== 'voice' && s.source !== 'screenshot')) continue;
      base.add(s.id);
      done(s.source, s.title);
    }
  }, [client, done]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === CAPTURE_SIGNAL && void look();
    window.addEventListener('storage', onStorage);
    const off = client.subscribe(() => void look());
    return () => {
      window.removeEventListener('storage', onStorage);
      off();
    };
  }, [client, look]);

  // Belt and braces while a capture is under way in the overlay window.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void look(), 4000);
    return () => clearInterval(t);
  }, [waiting, look]);

  const start = async (kind: 'voice' | 'screenshot') => {
    setWaiting(kind);
    if (!(await startCapture(kind))) setWaiting(null);
  };

  const saveNote = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    const space = spaces.data?.find((s) => s.personal) ?? spaces.data?.[0];
    if (!space) return setNoteError('There is no space to save into yet. Try again in a moment.');
    setBusy(true);
    setNoteError('');
    try {
      // Not ready (still downloading, or no runtime in this build): save as written now, extract later.
      const later = !(await localAiReady());
      const note = later ? null : await localAi.extractNote(body);
      const saved = await fileCapture(client, { source: 'note', title: note?.title ?? '', summary: note?.summary, spaceId: space.id, turns: [body], facts: note?.facts ?? [], extractLater: later });
      setWriting(false);
      done('note', saved.title);
    } catch (err) {
      setNoteError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const titleOf = (card: TryItCard): string | null => (tried.includes(card) ? (titles[card] ?? '') : null);

  // ── say something ──
  const whisper = setup.rows?.find((r) => r.role === 'whisper');
  const speechPending = Boolean(whisper && whisper.state !== 'ready');
  // Speech not on this Mac and nothing downloading (Later, or paused): offer just the speech model, right here.
  const offerSpeech = Boolean(whisper && speechPending && setup.phase !== 'downloading');
  const micOff = perms?.microphone === 'denied' || perms?.microphone === 'restricted';
  const voiceStatus = !desktop
    ? 'Needs OpenKT for Mac.'
    : offerSpeech && whisper
      ? `Voice needs the speech model (${formatBytes(rowRemaining(whisper))}). It is downloaded once and runs on this Mac.`
      : speechPending && whisper?.state === 'downloading'
        ? `Downloading the speech model — ${rowPercent(whisper)}%.`
        : speechPending
          ? `${finishingSetup(setup.percent)}. Speech works as soon as its model is on this Mac.`
          : micOff
        ? 'The microphone is off for OpenKT.'
        : waiting === 'voice'
          ? 'Talk, then press the keys again (or Save) — this card ticks itself.'
          : taken.has('voice')
            ? 'Another app uses these keys, so use Start.'
            : 'Or press the keys from any app.';
  const voiceAction =
    offerSpeech && whisper
      ? { label: `Download speech model (${formatBytes(rowRemaining(whisper))})`, onClick: () => void setup.download(['whisper']) }
      : micOff
        ? { label: 'Open System Settings', onClick: () => void openSettings('microphone'), dark: false }
        : { label: 'Start', onClick: () => void start('voice'), disabled: !desktop || speechPending };

  // ── capture what you see ──
  const screen = perms?.screen ?? 'unsupported';
  const screenBlocked = screen !== 'granted' && screen !== 'unsupported';
  const screenAction = actionFor('screen', screen);
  const shotStatus = !desktop
    ? 'Needs OpenKT for Mac.'
    : perms?.relaunchSuggested
      ? 'Turned on Screen Recording? OpenKT has to reopen to see it.'
      : screenBlocked
        ? 'Screen Recording is off for OpenKT.'
        : waiting === 'screenshot'
          ? 'Drag over part of the screen. Esc cancels.'
          : taken.has('screenshot')
            ? 'Another app uses these keys, so use Capture.'
            : 'Or press the keys from any app.';
  const shotAction = perms?.relaunchSuggested
    ? { label: 'Relaunch OpenKT', onClick: () => void relaunch() }
    : screenBlocked && screenAction.type !== 'none'
      ? { label: screenAction.label, onClick: () => void (screenAction.type === 'request' ? request('screen') : openSettings('screen')), dark: screenAction.type === 'request' }
      : { label: 'Capture', onClick: () => void start('screenshot'), disabled: !desktop || screenBlocked };

  return (
    <div className="onb__main">
      <h2 className="onb__h2">Try it</h2>
      <p className="lede onb__lede">Three small things, for real. Each one is saved to your private space, where only you can see it.</p>
      <ul className="plain tryits">
        <TryCard icon="mic" title="Say something" how="Press the keys, talk, press them again. You’ll see the words, then a note is saved." keys={offerSpeech ? undefined : VOICE_KEYS} done={titleOf('voice')} status={voiceStatus} action={voiceAction} />
        <TryCard icon="shot" title="Capture what you see" how="Drag over anything on screen. Its text is read on this Mac and saved." keys={SHOT_KEYS} done={titleOf('screenshot')} status={shotStatus} action={shotAction} />
        <TryCard
          icon="note"
          title="Write a note"
          how="A line or two about anything you’re working on."
          done={titleOf('note')}
          status={noteError || undefined}
          action={writing ? undefined : { label: 'Write', onClick: () => setWriting(true) }}
        >
          {writing && titleOf('note') === null && (
            <form className="tryit__form" onSubmit={(e) => void saveNote(e)}>
              <label htmlFor="tryit-note" className="sr-only">
                Note
              </label>
              <textarea
                id="tryit-note"
                className="input tryit__text"
                rows={3}
                autoFocus
                placeholder="Call with Ana — she wants the revised deck by Friday."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="tryit__formfoot">
                <button type="button" className="btn btn--box-sm" onClick={() => setWriting(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--box-sm btn--dark" disabled={!text.trim() || busy}>
                  {busy ? 'Saving…' : 'Save note'}
                </button>
              </div>
            </form>
          )}
        </TryCard>
      </ul>
      <div className="grow" />
      <div className="onb__foot">
        <span className="onb__note" role="status">
          {tried.length === 3 ? 'All three worked. You’re set.' : `${tried.length} of 3 tried. The menu bar has all of these any time.`}
        </span>
        <button type="button" className="btn btn--accent" onClick={() => onFinish(tried.length)}>
          Open OpenKT
        </button>
      </div>
    </div>
  );
}
