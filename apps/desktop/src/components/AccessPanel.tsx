import { useState, type FormEvent } from 'react';
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

/** Access.dc.html — the grants list, the invite field and the role explainer. */
export function AccessPanel({ resource, noun }: { resource: ResourceRef; noun: 'session' | 'space' }) {
  const client = useClient();
  const grants = useQuery((c) => c.listGrants(resource), [resource.type, resource.id]);
  const workspace = useQuery((c) => c.getWorkspace(), []);
  const [invite, setInvite] = useState('');
  const [hint, setHint] = useState('');

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    const q = invite.trim();
    if (!q) return;
    const have = new Set((grants.data ?? []).map((g) => `${g.subject.type}:${g.subject.id}`));
    const match = (await client.searchSubjects(q)).find((s) => !have.has(`${s.type}:${s.id}`));
    if (!match) {
      setHint(`no one new in ${workspace.data?.name ?? 'this workspace'} matches “${q}”`);
      return;
    }
    await client.putGrant(resource, match, 'reader');
    setInvite('');
    setHint(`${match.name.toLowerCase()} can now read this ${noun}`);
  };

  const onRole = (g: Grant, choice: RoleChoice) => {
    if (choice === 'remove') void client.deleteGrant(resource, g.subject);
    else void client.putGrant(resource, g.subject, choice);
  };

  return (
    <div className="access">
      <section className="access__list">
        <h2 className="h-label">Who can use this context</h2>
        <form className="access__invite" onSubmit={onInvite}>
          <label htmlFor="invite" className="sr-only">
            Add people or teams
          </label>
          <input
            id="invite"
            type="text"
            className="input"
            placeholder="Add people or teams"
            value={invite}
            autoComplete="off"
            onChange={(e) => {
              setInvite(e.target.value);
              setHint('');
            }}
          />
          <button type="submit" className="btn btn--dark btn--box">
            Invite
          </button>
        </form>
        {hint && (
          <p className="access__hint mono" role="status">
            {hint}
          </p>
        )}
        {grants.loading && !grants.data && <Loading />}
        {grants.error && <ErrorNote error={grants.error} />}
        <ul className="plain" aria-label="People and teams with access">
          {(grants.data ?? []).map((g) => (
            <li key={g.id} className="person">
              <Avatar initials={g.subject.initials} />
              <span className="person__text">
                <span className="person__name">{g.subject.name}</span>
                <span className="person__sub mono">{g.note}</span>
              </span>
              <Select<RoleChoice>
                label={`Role for ${g.subject.name}`}
                value={g.role}
                options={options(g, g.subject.id === workspace.data?.me.id)}
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
