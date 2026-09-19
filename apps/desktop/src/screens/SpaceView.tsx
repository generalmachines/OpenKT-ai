import { Link, useNavigate, useParams } from 'react-router-dom';
import { relativeDay } from '../api/format';
import { useQuery } from '../api/hooks';
import { AccessPanel } from '../components/AccessPanel';
import { Avatar, ErrorNote, Loading } from '../components/bits';
import { Icon, SOURCE_ICON } from '../components/Icon';
import { useSearch } from '../components/Shell';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Space.dc.html */
export function SpaceView() {
  const { id = '', tab } = useParams();
  const navigate = useNavigate();
  const openSearch = useSearch();
  const space = useQuery((c) => c.getSpace(id), [id]);
  const pages = useQuery((c) => c.listPages(id), [id]);
  const sessions = useQuery((c) => c.listSessions({ spaceId: id }), [id]);
  const grants = useQuery((c) => c.listGrants({ type: 'space', id }), [id]);
  const workspace = useQuery((c) => c.getWorkspace(), []);

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
  const people = (grants.data ?? []).filter((g) => g.subject.type === 'user').slice(0, 2);
  const rest = Math.max(0, sp.memberCount - people.length);
  const authorName = (authorId: string) => workspace.data?.people.find((p) => p.id === authorId)?.name.split(' ')[0] ?? '';
  const showingAccess = tab === 'access';

  return (
    <main className="main main--space">
      <div className="titlebar">
        <div className="titlebar__stack">
          <span className="mono crumb">
            <Link to="/spaces" className="quiet-link">
              space
            </Link>
          </span>
          <h1 className="h1">{sp.name}</h1>
        </div>
        <span className="avatars" aria-label={`${sp.memberCount} people`}>
          {people.map((g, i) => (
            <Avatar key={g.id} initials={g.subject.initials} size={34} fontSize={11} tone={i % 2 ? '#e3e1db' : undefined} />
          ))}
          {rest > 0 && <Avatar initials={`+${rest}`} size={34} fontSize={11} />}
        </span>
        <button type="button" className="btn btn--pill" aria-pressed={showingAccess} onClick={() => navigate(showingAccess ? `/spaces/${id}` : `/spaces/${id}/access`)}>
          <Icon name="users" size={15} />
          Access
        </button>
      </div>

      {showingAccess ? (
        <AccessPanel resource={{ type: 'space', id }} noun="space" />
      ) : (
        <>
          <button type="button" className="askbar" onClick={() => openSearch({ spaceId: id, label: sp.name })}>
            <Icon name="search" size={16} />
            <span>Ask this space anything</span>
          </button>
          <div className="space__cols">
            <section className="space__pages">
              <h2 className="h-label">Pages · kept current for you</h2>
              <ul className="plain">
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
              {pages.data?.length === 0 && <p className="empty">No pages yet. They appear once sessions are filed here and merged on your server.</p>}
            </section>
            <aside className="space__recent">
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
                        <span className="mrow__meta mono">
                          {authorName(s.authorId)} · {relativeDay(s.createdAt)}
                        </span>
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
    </main>
  );
}
