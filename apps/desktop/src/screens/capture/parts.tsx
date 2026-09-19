import { offset } from '../../api/format';
import { Icon } from '../../components/Icon';
import { Select, type SelectOption } from '../../components/Select';

/** Heights from design/gen.py `bars`. */
const BARS = [8, 14, 22, 12, 26, 18, 9, 20, 28, 16, 10, 22, 13, 7];

export const SPACE_OPTIONS: SelectOption<string>[] = [
  { value: 'sp-ideas', label: 'Ideas' },
  { value: 'sp-northgate', label: 'sales / northgate' },
  { value: 'sp-openkt', label: 'engineering / openkt' },
  { value: 'sp-marketing', label: 'marketing' },
  { value: 'sp-personal', label: 'Only me' },
];

const ACCESS_NOTE: Record<string, string> = {
  'sp-ideas': 'team can read',
  'sp-northgate': 'sales team can read',
  'sp-openkt': 'engineering can read',
  'sp-marketing': 'marketing can read',
  'sp-personal': 'private',
};

function SpacePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <Select label="Save to" variant="pill" align="left" up value={value} options={SPACE_OPTIONS} onChange={onChange} leading={<Icon name="folder" size={13} />} />;
}

export interface VoiceProps {
  text: string;
  tentative: string;
  elapsedSec: number;
  state: 'listening' | 'saved';
  spaceId: string;
  onSpace: (id: string) => void;
  live?: boolean;
  /** Right-hand hint. The artboard's copy assumes the engine's hold-to-talk. */
  hint?: string;
}

/** Capture-Voice.dc.html */
export function VoiceSheet({ text, tentative, elapsedSec, state, spaceId, onSpace, live, hint = 'release fn to save' }: VoiceProps) {
  return (
    <div className="sheet sheet--voice" role="status" aria-label="Voice capture">
      <div className="sheet__top">
        <span className={`bars${live && state === 'listening' ? ' is-live' : ''}`} aria-hidden="true">
          {BARS.map((h, i) => (
            <span key={i} style={{ height: h, animationDelay: `${(i * 83) % 600}ms` }} />
          ))}
        </span>
        <span className="mono small-meta" style={{ flexGrow: 1 }}>
          {state === 'listening' ? `listening · ${offset(elapsedSec)} · on this Mac` : `saved · ${offset(elapsedSec)} · transcribed on this Mac`}
        </span>
        <span className="mono small-meta">{state === 'listening' ? hint : 'filed'}</span>
      </div>
      <p className="sheet__text">
        {text}
        {text && tentative ? ' ' : ''}
        {tentative && <span className="sheet__tentative">{tentative}…</span>}
        {!text && !tentative && <span className="sheet__tentative">Say it out loud…</span>}
      </p>
      <div className="sheet__row">
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Save to</span>
        <SpacePicker value={spaceId} onChange={onSpace} />
        <span className="mono small-meta">{ACCESS_NOTE[spaceId] ?? ''}</span>
      </div>
    </div>
  );
}

/** Capture-Meeting.dc.html — the prompt card. */
export function MeetingPrompt({ app, onRecord, onDecline }: { app: string; onRecord: () => void; onDecline: () => void }) {
  return (
    <div className="sheet sheet--meeting" role="alertdialog" aria-label={`${app} is using your mic`}>
      <div className="sheet__top" style={{ gap: 10 }}>
        <span style={{ color: 'var(--ink-2)', display: 'flex' }}>
          <Icon name="video" size={17} />
        </span>
        <span className="sheet__title">{app} is using your mic</span>
      </div>
      <p className="sheet__body">Keep this meeting as a session? It is transcribed on this Mac. No bot joins, and the audio is never uploaded.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn--dark btn--box" style={{ flexGrow: 1, padding: 0 }} onClick={onRecord}>
          Record
        </button>
        <button type="button" className="btn btn--box btn--outline" style={{ flexGrow: 1, padding: 0 }} onClick={onDecline}>
          Not this one
        </button>
      </div>
      <span className="mono small-meta">tell the others you are recording</span>
    </div>
  );
}

/** Capture-Meeting.dc.html — the pill shown while recording. */
export function RecordingPill({ title, elapsedSec, onStop }: { title: string; elapsedSec: number; onStop?: () => void }) {
  const body = (
    <>
      <span className="recpill__dot" />
      <span style={{ fontSize: 13 }}>Recording · {title}</span>
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
        {offset(elapsedSec)}
      </span>
    </>
  );
  return onStop ? (
    <button type="button" className="recpill" onClick={onStop} title="Stop recording">
      {body}
    </button>
  ) : (
    <div className="recpill" role="status">
      {body}
    </div>
  );
}

/** Capture-Screenshot.dc.html */
export function ScreenshotSheet({ description, spaceId, onSpace, onSave, reading }: { description: string; spaceId: string; onSpace: (id: string) => void; onSave: () => void; reading?: boolean }) {
  return (
    <div className="sheet sheet--shot" role="dialog" aria-label="Screenshot captured">
      <div className="thumb" aria-hidden="true">
        <span style={{ width: '60%', height: 6, borderRadius: 3, background: '#d0cec8' }} />
        <span style={{ width: '90%', height: 4, borderRadius: 2, background: '#dedcd6' }} />
        <span style={{ width: '80%', height: 4, borderRadius: 2, background: '#dedcd6' }} />
      </div>
      <div className="sheet__col">
        <span style={{ fontSize: 14.5 }}>{reading ? <span className="sheet__tentative">Reading what is on screen…</span> : description}</span>
        <div className="sheet__row" style={{ paddingTop: 0 }}>
          <SpacePicker value={spaceId} onChange={onSpace} />
          <span className="mono small-meta" style={{ flexGrow: 1 }}>
            text read on this Mac
          </span>
          <button type="button" className="btn btn--dark btn--pill-sm" onClick={onSave} disabled={reading}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
