import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { describeError, type ContextKind } from '../api';
import { localAi } from '../api/bridge';
import { useClient, useQuery } from '../api/hooks';
import { Key, KindChip } from '../components/bits';
import { Icon } from '../components/Icon';
import { Select } from '../components/Select';

interface Draft {
  title: string;
  summary: string;
  facts: { text: string; kind: ContextKind; keep: boolean }[];
}

const KINDS: readonly ContextKind[] = ['decision', 'action', 'fact', 'question', 'how-to', 'idea', 'issue'];
const asKind = (k: string): ContextKind => KINDS.find((x) => x === k) ?? 'fact';

type Phase = { step: 'write' } | { step: 'extracting' } | { step: 'confirm'; draft: Draft } | { step: 'saving'; draft: Draft | null };

/**
 * No artboard: a note is a session like any other, so it borrows the session
 * layout. Save runs in two beats when this Mac has local AI: the model
 * proposes a title, a summary and facts; the person confirms; then the
 * session, its turn and each fact are filed and the session is closed.
 * Without local AI the note is filed exactly as written.
 */
export function NewNote() {
  const client = useClient();
  const navigate = useNavigate();
  const spaces = useQuery((c) => c.listSpaces(), []);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [phase, setPhase] = useState<Phase>({ step: 'write' });
  const [error, setError] = useState('');

  // Default to the personal space once the list arrives: nothing is ever dropped for lack of somewhere to put it.
  useEffect(() => {
    if (!spaceId && spaces.data?.length) setSpaceId((spaces.data.find((s) => s.personal) ?? spaces.data[0]!).id);
  }, [spaceId, spaces.data]);

  const firstLine = text.trim().split('\n')[0]?.slice(0, 60) ?? '';
  const empty = !title.trim() && !text.trim();

  const file = async (draft: Draft | null) => {
    setPhase({ step: 'saving', draft });
    setError('');
    try {
      const session = await client.createSession({
        source: 'note',
        title: title.trim() || draft?.title.trim() || firstLine,
        spaceId,
        text,
      });
      for (const f of draft?.facts ?? []) {
        if (f.keep && f.text.trim())
          await client.saveFact({
            sessionId: session.id,
            spaceId,
            statement: f.text,
            kind: f.kind,
          });
      }
      await client.closeSession(session.id, draft?.summary.trim() || text.trim().slice(0, 600));
      navigate(`/sessions/${session.id}${draft?.facts.some((f) => f.keep) ? '/context' : ''}`);
    } catch (e) {
      setError(describeError(e));
      setPhase(draft ? { step: 'confirm', draft } : { step: 'write' });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (empty || !spaceId) return;
    if (phase.step === 'confirm') return file(phase.draft);
    if (!localAi.available() || !text.trim()) return file(null);
    setPhase({ step: 'extracting' });
    const got = await localAi.extractNote(text);
    if (!got) return file(null);
    setPhase({
      step: 'confirm',
      draft: {
        title: got.title,
        summary: got.summary,
        facts: got.facts.map((f) => ({ text: f.statement, kind: asKind(f.kind), keep: true })),
      },
    });
    if (!title.trim() && got.title) setTitle(got.title);
  };

  const space = spaces.data?.find((s) => s.id === spaceId);
  const draft = phase.step === 'confirm' ? phase.draft : null;
  const patchDraft = (p: Partial<Draft>) => draft && setPhase({ step: 'confirm', draft: { ...draft, ...p } });
  const busy = phase.step === 'extracting' || phase.step === 'saving';
  const kept = draft?.facts.filter((f) => f.keep && f.text.trim()).length ?? 0;

  return (
    <main className="main main--session">
      <form className="note" onSubmit={save} aria-busy={busy || undefined}>
        <label htmlFor="note-title" className="sr-only">
          Title
        </label>
        <input id="note-title" className="note__title" placeholder="Untitled note" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <div className="shead__meta mono">
          <span className="with-icon">
            <Icon name="note" size={13} />
            note · now
          </span>
          <span className="with-icon">
            <Icon name="lock" size={13} />
            {space?.personal ? 'only you' : `filed in ${space?.name ?? ''}`}
          </span>
        </div>
        <div className="rule" />
        {draft ? (
          <section className="extract" aria-label="Extracted from your note">
            <label className="extract__label mono" htmlFor="note-summary">
              Summary
            </label>
            <textarea id="note-summary" className="extract__summary" value={draft.summary} onChange={(e) => patchDraft({ summary: e.target.value })} />
            <span className="extract__label mono">
              Context · {kept} of {draft.facts.length} kept
            </span>
            {draft.facts.length === 0 && <p className="state mono">nothing worth keeping on its own — the note is still saved</p>}
            <ul className="plain">
              {draft.facts.map((f, i) => (
                <li key={i} className={`extract__fact${f.keep ? '' : ' extract__fact--off'}`}>
                  <input
                    type="checkbox"
                    aria-label={`Keep: ${f.text}`}
                    checked={f.keep}
                    onChange={(e) =>
                      patchDraft({
                        facts: draft.facts.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)),
                      })
                    }
                  />
                  <KindChip kind={f.kind} />
                  <input
                    type="text"
                    aria-label={`Fact ${i + 1}`}
                    value={f.text}
                    onChange={(e) =>
                      patchDraft({
                        facts: draft.facts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <>
            <label htmlFor="note-body" className="sr-only">
              Note
            </label>
            <textarea
              id="note-body"
              className="note__body"
              placeholder={localAi.available() ? 'Write it down. Context is extracted on this Mac when you save.' : 'Write it down.'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={busy}
            />
          </>
        )}
        {error && (
          <p className="state mono" role="alert">
            {error}
          </p>
        )}
        <footer className="sfoot">
          <span className="sfoot__text" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5 }}>Save to</span>
            <Select
              label="Save to space"
              variant="pill"
              align="left"
              up
              value={spaceId}
              onChange={setSpaceId}
              options={(spaces.data ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              leading={<Icon name="folder" size={13} />}
            />
            {draft ? (
              <button type="button" className="linkbtn" style={{ fontSize: 12.5 }} onClick={() => setPhase({ step: 'write' })}>
                Back to the note
              </button>
            ) : (
              <span className="mono small-meta">
                {phase.step === 'extracting' ? (
                  'reading your note on this Mac…'
                ) : phase.step === 'saving' ? (
                  'filing…'
                ) : (
                  <>
                    or hold <Key>fn</Key> and say it
                  </>
                )}
              </span>
            )}
          </span>
          <button type="submit" className="btn btn--dark btn--pill-sm" disabled={empty || !spaceId || busy}>
            {draft ? (kept ? `Save with ${kept} ${kept === 1 ? 'fact' : 'facts'}` : 'Save note') : 'Save'}
          </button>
        </footer>
      </form>
    </main>
  );
}
