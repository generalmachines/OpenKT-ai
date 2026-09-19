import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { describeError } from '../api/errors';
import { firstName, relativeDay, roleLabel } from '../api/format';
import { useClient, useQuery } from '../api/hooks';
import type { ContextItem, Space, SpaceMember } from '../api/types';
import { AccessPanel } from '../components/AccessPanel';
import { Avatar, ErrorNote, KindChip, Loading } from '../components/bits';
import { Icon, SOURCE_ICON } from '../components/Icon';
import { Overlay } from '../components/Overlay';
import { useSearch } from '../components/Shell';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Copy to the clipboard; false when the page may not (the link is then shown to copy by hand). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function MemberRow({ m }: { m: SpaceMember }) {
  const sub = m.pending ? 'invited · hasn’t joined yet' : [m.role ? roleLabel(m.role).toLowerCase() : '', m.you ? 'you' : ''].filter(Boolean).join(' · ');
  return (
    <li className={`member${m.pending ? ' member--pending' : ''}`}>
      <Avatar initials={m.pending ? '@' : m.initials} size={26} fontSize={10} />
      <span className="member__text">
        <span className="member__name">{m.name}</span>
        {sub && <span className="member__sub mono">{sub}</span>}
      </span>
    </li>
  );
}

function ContextRow({ item, sessionTitle }: { item: ContextItem; sessionTitle?: string }) {
  return (
    <li>
      <Link to={item.sessionId ? `/sessions/${item.sessionId}/context` : '#'} className="sctx">
        <KindChip kind={item.kind} />
        <span className="sctx__text">
          <span className="sctx__statement">{item.statement}</span>
          <span className="sctx__meta mono">
            {[item.author, sessionTitle, relativeDay(item.createdAt)].filter(Boolean).join(' · ')}
          </span>
        </span>
      </Link>
    </li>
  );
}

function InviteSheet({ space, onClose }: { space: Space; onClose: () => void }) {
  return (
    <Overlay title={`Invite to “${space.name}”`} subtitle={space.slug} onClose={onClose} width={640}>
      <div className="modal__scroll">
        <AccessPanel resource={{ type: 'space', id: space.id }} noun="space" layout="sheet" />
      </div>
    </Overlay>
  );
}

/** Space.dc.html — plus who is in the space and who saved what. */
export function SpaceView() {
  const { id = '', tab } = useParams();
  const navigate = useNavigate();
  const client = useClient();
  const openSearch = useSearch();
  const space = useQuery((c) => c.getSpace(id), [id]);
  const pages = useQuery((c) => c.listPages(id), [id]);
  const sessions = useQuery((c) => c.listSessions({ spaceId: id }), [id]);
  const context = useQuery((c) => c.listSpaceContext(id, { limit: 12 }), [id]);
  const members = useQuery((c) => c.listSpaceMembers(id), [id]);
  const caps = useQuery((c) => c.capabilities(), []);
  const [inviting, setInviting] = useState(false);
  const [linkNote, setLinkNote] = useState<{ tone: 'ok' | 'error'; text: string; url?: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  if (space.error) {
    return (
      <main className="main main--space">
        <ErrorNote error={space.error} onRetry={space.reload} />
      </main>
    );
  }
  if (!space.data) {
    return (
      <main className="main main--space" aria-busy="true">
        <Loading />
      </main>
    );
  }

  const sp = space.data;
  const owner = sp.myRole === 'owner';
  const canSave = sp.myRole !== 'reader';
  const people = (members.data?.members ?? []).filter((m) => !m.pending);
  const shown = people.slice(0, 3);
  const headcount = Math.max(people.length, sp.memberCount);
  const rest = Math.max(0, headcount - shown.length);
  const showingAccess = tab === 'access';
  const titles = new Map((sessions.data ?? []).map((s) => [s.id, s.title]));

  const copyLink = async () => {
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      const link = await client.createJoinLink(sp.id, 'editor');
      const copied = await copyText(link.url);
      setLinkNote(
        copied
          ? { tone: 'ok', text: 'Invite link copied. Anyone who has it can join this space as an editor.' }
          : { tone: 'ok', text: 'Copy this link and send it. Anyone who has it can join this space as an editor.', url: link.url },
      );
    } catch (e) {
      setLinkNote({ tone: 'error', text: describeError(e) });
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <main className="main main--space">
      <div className="titlebar">
        <div className="titlebar__stack">
          <span className="mono crumb">
            <Link to="/spaces" className="quiet-link">
              space
            </Link>
            {!sp.personal && !owner && sp.myRole ? ` · shared with you · ${sp.myRole}` : ''}
          </span>
          <h1 className="h1">{sp.name}</h1>
        </div>
        {!sp.personal && (
          <span className="avatars" aria-label={`${headcount} ${headcount === 1 ? 'person' : 'people'}`}>
            {shown.map((m, i) => (
              <Avatar key={m.id} initials={m.initials} size={34} fontSize={11} tone={i % 2 ? '#e3e1db' : undefined} />
            ))}
            {rest > 0 && <Avatar initials={`+${rest}`} size={34} fontSize={11} />}
          </span>
        )}
        {canSave && !sp.personal && caps.data?.joinLinks && (
          <button type="button" className="btn btn--pill" onClick={() => void copyLink()} disabled={linkBusy}>
            <Icon name="copy" size={15} />
            Copy invite link
          </button>
        )}
        {owner && !sp.personal && (
          <button type="button" className="btn btn--pill" onClick={() => setInviting(true)}>
            <Icon name="plus" size={15} />
            Invite
          </button>
        )}
        {owner && (
          <button type="button" className="btn btn--pill" aria-pressed={showingAccess} onClick={() => navigate(showingAccess ? `/spaces/${id}` : `/spaces/${id}/access`)}>
            <Icon name="users" size={15} />
            Access
          </button>
        )}
      </div>
      {sp.description && <p className="space__about">{sp.description}</p>}
      {linkNote && (
        <p className={`space__note${linkNote.tone === 'error' ? ' space__note--error' : ''}`} role={linkNote.tone === 'error' ? 'alert' : 'status'}>
          {linkNote.text}
          {linkNote.url && (
            <input className="input space__link mono" readOnly value={linkNote.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
          )}
        </p>
      )}

      {showingAccess && owner ? (
        <AccessPanel resource={{ type: 'space', id }} noun="space" />
      ) : (
        <>
          <div className="space__ask">
            <button type="button" className="askbar" onClick={() => openSearch({ spaceId: id, label: sp.name })}>
              <Icon name="search" size={16} />
              <span>Ask this space anything</span>
            </button>
            {canSave && (
              <Link to={`/new?space=${encodeURIComponent(id)}`} className="btn btn--pill space__new">
                <Icon name="note" size={15} />
                New note here
              </Link>
            )}
          </div>
          <div className="space__cols">
            <section className="space__pages">
              {(pages.data?.length ?? 0) > 0 && (
                <>
                  <h2 className="h-label">Pages · kept current for you</h2>
                  <ul className="plain space__block">
                    {(pages.data ?? []).map((p) => (
                      <li key={p.id}>
                        <Link to={`/pages/${p.id}`} className="prow">
                          <span className="prow__title">{p.title}</span>
                          <span className="prow__desc">{p.summary}</span>
                          <span className="prow__meta mono">
                            {plural(p.sessionCount, 'session')} · changed {relativeDay(p.updatedAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h2 className="h-label">Context · who saved what</h2>
              {context.loading && !context.data && <Loading />}
              {context.error && <ErrorNote error={context.error} />}
              <ul className="plain" aria-label="Context in this space">
                {(context.data ?? []).map((c) => (
                  <ContextRow key={c.id} item={c} sessionTitle={titles.get(c.sessionId)} />
                ))}
              </ul>
              {context.data?.length === 0 && (
                <p className="empty">
                  Nothing saved here yet. A note, a voice note or a screenshot saved into {sp.personal ? 'your personal space' : 'this space'} shows up here with who saved it
                  {sp.personal ? '.' : ', for everyone in it.'}
                </p>
              )}
            </section>
            <aside className="space__recent">
              {!sp.personal && (
                <>
                  <h2 className="h-label">People</h2>
                  <ul className="plain space__block" aria-label="People in this space">
                    {(members.data?.members ?? []).map((m) => (
                      <MemberRow key={`${m.id}-${m.pending ? 'p' : 'm'}`} m={m} />
                    ))}
                  </ul>
                  {members.data && !members.data.complete && <p className="space__fine mono">only the owner sees everyone with access</p>}
                  {owner && people.length <= 1 && (
                    <button type="button" className="linkbtn space__fine-btn" onClick={() => setInviting(true)}>
                      Invite your team
                    </button>
                  )}
                </>
              )}
              <h2 className="h-label">Recent sessions</h2>
              <ul className="plain">
                {(sessions.data ?? []).slice(0, 6).map((s) => (
                  <li key={s.id}>
                    <Link to={`/sessions/${s.id}`} className="mrow">
                      <span className="mrow__icon">
                        <Icon name={SOURCE_ICON[s.source]} size={14} />
                      </span>
                      <span className="mrow__text">
                        <span className="mrow__title">{s.title}</span>
                        <span className="mrow__meta mono">{[s.authorName ? firstName(s.authorName) : '', relativeDay(s.createdAt)].filter(Boolean).join(' · ')}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {sessions.data?.length === 0 && <p className="empty">Nothing filed here yet.</p>}
            </aside>
          </div>
        </>
      )}
      {inviting && <InviteSheet space={sp} onClose={() => setInviting(false)} />}
    </main>
  );
}
