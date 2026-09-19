import { useState, type FormEvent } from 'react';
import { describeError } from '../api/errors';
import { roleLabel } from '../api/format';
import { useClient, useQuery } from '../api/hooks';
import { ROLES, type Grant, type ResourceRef, type Role } from '../api/types';
import { Avatar, ErrorNote, Loading } from './bits';
import { Icon } from './Icon';
import { Select, type SelectOption } from './Select';

type RoleChoice = Role | 'remove';

function options(g: Grant, isMe: boolean): SelectOption<RoleChoice>[] {
  const roles: SelectOption<RoleChoice>[] = ROLES.map((r) => ({ value: r, label: roleLabel(r) }));
  if (g.inherited || isMe) return roles;
  return [...roles, { value: 'remove', label: 'Remove access', destructive: true }];
}

type InviteRole = Extract<Role, 'reader' | 'editor'>;
const INVITE_ROLES: SelectOption<InviteRole>[] = [
  { value: 'reader', label: 'Reader' },
  { value: 'editor', label: 'Editor' },
];

/** Deliberately loose: one @, something on both sides, a dot in the domain. The server has the last word. */
export const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

type Hint = { tone: 'ok' | 'error'; text: string };

/** Access.dc.html — the grants list, share-by-email and the role explainer. */
export function AccessPanel({ resource, noun }: { resource: ResourceRef; noun: 'session' | 'space' }) {
  const client = useClient();
  const grants = useQuery((c) => c.listGrants(resource), [resource.type, resource.id]);
  const me = useQuery((c) => c.getMe(), []);
  const [invite, setInvite] = useState('');
  const [role, setRole] = useState<InviteRole>('reader');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    const email = invite.trim();
    if (!email || busy) return;
    if (!looksLikeEmail(email)) return setHint({ tone: 'error', text: 'Enter a full email address, like name@company.com.' });
    if (me.data?.email && me.data.email.toLowerCase() === email.toLowerCase()) return setHint({ tone: 'error', text: 'That’s you — you already have access.' });
    setBusy(true);
    try {
      const grant = await client.inviteByEmail(resource, email, role);
      setInvite('');
      setHint({
        tone: 'ok',
        text: grant.pending
          ? `${email} isn’t on OpenKT yet. They’ll get access to this ${noun} as soon as they join.`
          : `${grant.subject.name} can now ${role === 'editor' ? 'edit' : 'read'} this ${noun}.`,
      });
    } catch (err) {
      setHint({ tone: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const onRole = (g: Grant, choice: RoleChoice) => {
    const done = choice === 'remove' ? client.deleteGrant(resource, g.subject) : client.putGrant(resource, g.subject, choice);
    void done.catch((err: unknown) => setHint({ tone: 'error', text: describeError(err) }));
  };

  return (
    <div className="access">
      <section className="access__list">
        <h2 className="h-label">Who can use this context</h2>
        <form className="access__invite" onSubmit={onInvite} noValidate>
          <label htmlFor="invite" className="sr-only">
            Invite by email
          </label>
          <input
            id="invite"
            type="email"
            inputMode="email"
            className="input"
            placeholder="Invite by email"
            value={invite}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={hint?.tone === 'error' || undefined}
            aria-describedby={hint ? 'invite-hint' : undefined}
            onChange={(e) => {
              setInvite(e.target.value);
              setHint(null);
            }}
          />
          <Select<InviteRole> label="Invite as" value={role} options={INVITE_ROLES} onChange={setRole} style={{ minWidth: 104, height: 44 }} />
          <button type="submit" className="btn btn--dark btn--box" disabled={busy || !invite.trim()}>
            Invite
          </button>
        </form>
        {hint && (
          <p id="invite-hint" className={`access__hint${hint.tone === 'error' ? ' access__hint--error' : ''}`} role={hint.tone === 'error' ? 'alert' : 'status'}>
            {hint.text}
          </p>
        )}
        {grants.loading && !grants.data && <Loading />}
        {grants.error && <ErrorNote error={grants.error} />}
        <ul className="plain" aria-label="People and teams with access">
          {(grants.data ?? []).map((g) => (
            <li key={g.id} className={`person${g.pending ? ' person--pending' : ''}`}>
              <Avatar initials={g.pending ? '@' : g.subject.initials} />
              <span className="person__text">
                <span className="person__name">{g.subject.name}</span>
                <span className="person__sub mono">{g.pending ? 'Invited — hasn’t joined yet' : [g.subject.email, g.note].filter(Boolean).join(' · ')}</span>
              </span>
              <Select<RoleChoice>
                label={`Role for ${g.subject.name}`}
                value={g.role}
                options={options(g, g.subject.id === me.data?.id)}
                onChange={(v) => onRole(g, v)}
                style={{ minWidth: 104 }}
              />
            </li>
          ))}
        </ul>
      </section>
      <aside className="access__aside">
        <div className="card card--roles">
          <h3>What each role means</h3>
          <p>
            <strong>Reader</strong> — their tools can retrieve this context. They cannot open the transcript.
          </p>
          <p>
            <strong>Editor</strong> — reads the transcript, corrects and adds context.
          </p>
          <p>
            <strong>Owner</strong> — changes access, deletes the {noun}.
          </p>
        </div>
        {noun === 'session' ? (
          <div className="access__privacy">
            <span className="access__privacy-head">
              <Icon name="lock" size={14} />
              The recording never left this Mac
            </span>
            <span>Only the transcript and saved context sync. Meetings default to the space they are filed in — change that in Settings.</span>
          </div>
        ) : (
          <div className="access__privacy">
            <span className="access__privacy-head">
              <Icon name="lock" size={14} />
              Sessions and pages inherit from the space
            </span>
            <span>Anyone added here can retrieve what is filed in this space. A single session can still be narrowed or widened on its own.</span>
          </div>
        )}
      </aside>
    </div>
  );
}
