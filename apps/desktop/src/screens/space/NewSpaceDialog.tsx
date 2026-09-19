import { useState, type FormEvent } from 'react';
import { describeError } from '../../api/errors';
import { useClient, useQuery } from '../../api/hooks';
import { spaceSlug } from '../../api/spaces';
import type { Role, Space } from '../../api/types';
import { looksLikeEmail } from '../../components/AccessPanel';
import { Overlay } from '../../components/Overlay';
import { Select, type SelectOption } from '../../components/Select';

type Who = 'me' | 'people';
type ShareRole = Extract<Role, 'reader' | 'editor'>;

const ROLE_OPTIONS: SelectOption<ShareRole>[] = [
  { value: 'editor', label: 'Editors — save into it' },
  { value: 'reader', label: 'Readers — search it' },
];

/** "ana@x.com, ravi@x.com\nsam@x.com" → the addresses, lower-cased, once each. */
export function parseEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    const e = part.trim().replace(/^<|>$/g, '').toLowerCase();
    if (e) seen.add(e);
  }
  return [...seen];
}

interface Created {
  space: Space;
  /** "email — why" for each share that did not go through. */
  failed: string[];
}

/**
 * New space: a name, an optional line about it, and who it is for. "Share with
 * people" takes emails; someone without an account yet gets access when they
 * sign up. The slug is made from the name (a taken one gets `-2`, `-3`…).
 */
export function NewSpaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (space: Space) => void }) {
  const client = useClient();
  const me = useQuery((c) => c.getMe(), []);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [who, setWho] = useState<Who>('me');
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<ShareRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (created) return onCreated(created.space);
    if (!name.trim()) return setError('Give it a name — a project, a customer or a team, like “Q4 launch”.');
    const list = who === 'people' ? parseEmails(emails) : [];
    const bad = list.filter((x) => !looksLikeEmail(x));
    if (bad.length) return setError(`${bad.join(', ')} ${bad.length === 1 ? 'isn’t a full email address' : 'aren’t full email addresses'}. Use name@company.com.`);
    if (who === 'people' && list.length === 0) return setError('Add at least one email, or choose Just me.');
    const mine = me.data?.email.toLowerCase();
    const others = list.filter((x) => x !== mine);

    setBusy(true);
    setError(null);
    let space: Space;
    try {
      space = await client.createSpace({ name: name.trim(), description: description.trim() || undefined });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
      return;
    }
    const failed: string[] = [];
    for (const email of others) {
      try {
        await client.inviteByEmail({ type: 'space', id: space.id }, email, role);
      } catch (err) {
        failed.push(`${email} — ${describeError(err)}`);
      }
    }
    setBusy(false);
    if (failed.length) return setCreated({ space, failed });
    onCreated(space);
  };

  const slug = name.trim() ? spaceSlug(name) : '';

  return (
    <Overlay title="New space" onClose={onClose} width={480} subtitle={slug && !created ? slug : undefined}>
      <form className="form" onSubmit={submit} noValidate>
        {created ? (
          <div className="form__done" role="status">
            <p>
              <strong>{created.space.name}</strong> is ready. These shares didn’t go through — try them again from the space’s Access tab:
            </p>
            <ul className="plain form__failed">
              {created.failed.map((f) => (
                <li key={f} className="mono">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <label htmlFor="space-name" className="field__label">
              Name
            </label>
            <input
              id="space-name"
              className="input"
              placeholder="Q4 launch"
              value={name}
              maxLength={120}
              autoComplete="off"
              data-autofocus
              aria-invalid={error && !name.trim() ? true : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
            <label htmlFor="space-about" className="field__label">
              What goes in it <span className="field__optional">optional</span>
            </label>
            <input
              id="space-about"
              className="input"
              placeholder="Decisions, calls and notes for the launch"
              value={description}
              maxLength={300}
              autoComplete="off"
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="field__label" id="space-who">
              Who it’s for
            </span>
            <div className="choices" role="radiogroup" aria-labelledby="space-who">
              <label className={`choice${who === 'me' ? ' is-on' : ''}`}>
                <input type="radio" name="space-who" value="me" checked={who === 'me'} onChange={() => setWho('me')} />
                <span className="choice__text">
                  <span className="choice__title">Just me</span>
                  <span className="choice__sub">Private until you share it.</span>
                </span>
              </label>
              <label className={`choice${who === 'people' ? ' is-on' : ''}`}>
                <input type="radio" name="space-who" value="people" checked={who === 'people'} onChange={() => setWho('people')} />
                <span className="choice__text">
                  <span className="choice__title">Share with people</span>
                  <span className="choice__sub">Your team, by email.</span>
                </span>
              </label>
            </div>
            {who === 'people' && (
              <>
                <label htmlFor="space-emails" className="field__label">
                  Emails
                </label>
                <textarea
                  id="space-emails"
                  className="input form__emails"
                  placeholder="ana@company.com, ravi@company.com"
                  value={emails}
                  spellCheck={false}
                  onChange={(e) => {
                    setEmails(e.target.value);
                    setError(null);
                  }}
                />
                <div className="form__row">
                  <span className="form__row-label">They join as</span>
                  <Select<ShareRole> label="They join as" value={role} options={ROLE_OPTIONS} onChange={setRole} align="left" style={{ height: 36 }} />
                </div>
                <p className="form__hint">Someone who isn’t on OpenKT yet gets access as soon as they sign up with that email.</p>
              </>
            )}
          </>
        )}
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions modal__actions--flush">
          {!created && (
            <button type="button" className="btn btn--pill" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn--pill btn--dark btn--run" disabled={busy}>
            {created ? 'Open the space' : busy ? 'Creating…' : 'Create space'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
