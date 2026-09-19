import { useState } from 'react';
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

function SpacePicker({ value, onChange, options = SPACE_OPTIONS, display }: { value: string; onChange: (v: string) => void; options?: SelectOption<string>[]; display?: string }) {
  return <Select label="Save to" variant="pill" align="left" up value={value} options={options} onChange={onChange} display={display} leading={<Icon name="folder" size={13} />} />;
}

/** `setup`: the speech model is still downloading — the pill says how far along, instead of failing. */
export type VoiceState = 'listening' | 'transcribing' | 'review' | 'saving' | 'saved' | 'empty' | 'permission' | 'failed' | 'setup';

const VOICE_STATUS: Record<VoiceState, (t: string) => string> = {
  listening: (t) => `listening · ${t} · on this Mac`,
  transcribing: (t) => `transcribing… · ${t} · on this Mac`,
  review: (t) => `transcribed · ${t} · on this Mac`,
  saving: (t) => `filing… · ${t}`,
  saved: (t) => `saved · ${t} · transcribed on this Mac`,
  empty: () => 'nothing heard',
  permission: () => 'microphone blocked',
  failed: () => 'could not transcribe',
  setup: () => 'speech not on this Mac yet',
};

export interface VoiceProps {
  text: string;
  tentative: string;
  elapsedSec: number;
  state: VoiceState;
  spaceId: string;
  onSpace: (id: string) => void;
  live?: boolean;
  /** Right-hand hint. The artboard's copy assumes the engine's hold-to-talk. */
  hint?: string;
  /** Recent microphone levels, 0..1, oldest first. When given they drive the bars instead of the artboard's heights. */
  levels?: number[];
  /** Real spaces; the artboard's list otherwise. */
  spaces?: SelectOption<string>[];
  /** Short name on the picker button when the menu's labels are longer. */
  spaceLabel?: string;
  accessNote?: string;
  /** One calm line under the text: why there are no facts yet, or what went wrong. */
  notice?: string;
  onSave?: () => void;
  /** One button under the notice — e.g. "Download the speech model (574 MB)" when voice needs it. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
}

const VOICE_HINT: Partial<Record<VoiceState, string>> = { transcribing: 'one moment', review: 'esc to discard', saving: '', saved: 'filed', empty: '', permission: 'esc to close', failed: 'esc to close', setup: 'esc to close' };

/** Capture-Voice.dc.html */
export function VoiceSheet({ text, tentative, elapsedSec, state, spaceId, onSpace, live, hint = 'release fn to save', levels, spaces, spaceLabel, accessNote, notice, onSave, action }: VoiceProps) {
  const listening = state === 'listening';
  return (
    <div className="sheet sheet--voice" role="status" aria-label="Voice capture">
      <div className="sheet__top">
        <span className={`bars${live && listening && !levels ? ' is-live' : ''}${listening ? '' : ' is-idle'}`} aria-hidden="true">
          {BARS.map((h, i) => (
            <span key={i} style={levels ? { height: Math.round(4 + Math.max(0, Math.min(1, levels[levels.length - BARS.length + i] ?? 0)) * 24) } : { height: h, animationDelay: `${(i * 83) % 600}ms` }} />
          ))}
        </span>
        <span className="mono small-meta" style={{ flexGrow: 1 }}>
          {VOICE_STATUS[state](offset(elapsedSec))}
        </span>
        <span className="mono small-meta" style={{ whiteSpace: 'nowrap' }}>
          {listening ? hint : (VOICE_HINT[state] ?? '')}
        </span>
      </div>
      {(text || tentative || listening || state === 'transcribing') && (
        <p className="sheet__text">
          {text}
          {text && tentative ? ' ' : ''}
          {tentative && <span className="sheet__tentative">{tentative}…</span>}
          {!text && !tentative && <span className="sheet__tentative">{listening ? 'Say it out loud…' : 'Transcribing on this Mac…'}</span>}
        </p>
      )}
      {notice && (
        <p className="sheet__notice mono" role={state === 'permission' || state === 'failed' ? 'alert' : undefined}>
          {notice}
        </p>
      )}
      {action && (
        <button type="button" className="btn btn--dark btn--pill-sm sheet__action" disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {state !== 'empty' && state !== 'permission' && state !== 'failed' && state !== 'setup' && (
        <div className="sheet__row">
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Save to</span>
          <SpacePicker value={spaceId} onChange={onSpace} options={spaces} display={spaceLabel} />
          <span className="mono small-meta" style={onSave ? { flexGrow: 1 } : undefined}>
            {accessNote ?? ACCESS_NOTE[spaceId] ?? ''}
          </span>
          {onSave && (state === 'review' || state === 'saving') && (
            <button type="button" className="btn btn--dark btn--pill-sm" onClick={onSave} disabled={state === 'saving'}>
              Save
            </button>
          )}
        </div>
      )}
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

export interface ScreenshotProps {
  description: string;
  spaceId: string;
  onSpace: (id: string) => void;
  onSave: () => void;
  reading?: boolean;
  /** When given, the description is an editable title line. */
  onDescription?: (v: string) => void;
  /** file:// or data: URL of the capture; the artboard's placeholder lines otherwise. */
  image?: string;
  spaces?: SelectOption<string>[];
  spaceLabel?: string;
  /** Replaces the "text read on this Mac" line: progress, or why nothing was saved. */
  note?: string;
  saving?: boolean;
  /** Nothing to save (Spec 03 §4): the sheet says so and offers only Close. */
  nothing?: boolean;
}

/** Capture-Screenshot.dc.html */
export function ScreenshotSheet({ description, spaceId, onSpace, onSave, reading, onDescription, image, spaces, spaceLabel, note, saving, nothing }: ScreenshotProps) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="sheet sheet--shot" role="dialog" aria-label="Screenshot captured">
      {image && !broken ? (
        <img className="thumb thumb--img" src={image} alt="" onError={() => setBroken(true)} />
      ) : (
        <div className="thumb" aria-hidden="true">
          <span style={{ width: '60%', height: 6, borderRadius: 3, background: '#d0cec8' }} />
          <span style={{ width: '90%', height: 4, borderRadius: 2, background: '#dedcd6' }} />
          <span style={{ width: '80%', height: 4, borderRadius: 2, background: '#dedcd6' }} />
        </div>
      )}
      <div className="sheet__col">
        {reading ? (
          <span style={{ fontSize: 14.5 }}>
            <span className="sheet__tentative">Reading what is on screen…</span>
          </span>
        ) : onDescription && !nothing ? (
          <input className="sheet__title-input" aria-label="Title" value={description} onChange={(e) => onDescription(e.target.value)} spellCheck={false} />
        ) : (
          <span style={{ fontSize: 14.5 }}>{description}</span>
        )}
        <div className="sheet__row" style={{ paddingTop: 0 }}>
          {!nothing && <SpacePicker value={spaceId} onChange={onSpace} options={spaces} display={spaceLabel} />}
          <span className="mono small-meta" style={{ flexGrow: 1 }}>
            {note ?? 'text read on this Mac'}
          </span>
          <button type="button" className="btn btn--dark btn--pill-sm" onClick={onSave} disabled={reading || saving || (!nothing && !description.trim())}>
            {nothing ? 'Close' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
