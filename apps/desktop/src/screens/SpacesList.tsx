import { Link } from 'react-router-dom';
import { relativeDay } from '../api/format';
import { useQuery } from '../api/hooks';
import { ErrorNote, Loading } from '../components/bits';
import { Icon } from '../components/Icon';

/** No artboard of its own: built from the Skills header and the Space page rows. */
export function SpacesList() {
  const spaces = useQuery((c) => c.listSpaces(), []);
  return (
    <main className="main main--list">
      <div className="titlebar">
        <h1 className="h1 h1--sm">Spaces</h1>
        <button type="button" className="btn btn--dark btn--cta" disabled title="Creating spaces arrives with the server">
          <Icon name="plus" size={15} />
          New space
        </button>
      </div>
      <p className="lede" style={{ maxWidth: 600 }}>
        Where context is filed: a project, a customer, a team, ideas. Pages inside a space keep themselves current, and access is set once for everything in it.
      </p>
      {spaces.loading && !spaces.data && <Loading />}
      {spaces.error && <ErrorNote error={spaces.error} />}
      <ul className="plain rows" style={{ maxWidth: 860 }}>
        {(spaces.data ?? []).map((s) => (
          <li key={s.id}>
            <Link to={`/spaces/${s.id}`} className="prow">
              <span className="prow__title">{s.name}</span>
              <span className="prow__desc">{s.description}</span>
              <span className="prow__meta mono">
                {s.pageCount} pages · {s.sessionCount} sessions · {s.personal ? 'only you' : `${s.memberCount} people`} · changed {relativeDay(s.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
