import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { accessSummary, relativeDayTime } from '../api/format';
import { useQuery } from '../api/hooks';
import { ErrorNote, Loading } from '../components/bits';
import { Icon, SOURCE_ICON } from '../components/Icon';
import { ChangesBlock, Cites, FactsBlock, ForkBlock, PagePeople, RelatedPages } from '../components/PageBlocks';
import { PreviewBadge } from '../components/PreviewBadge';
import { ReadOnlyNote } from '../components/ReadOnlyNote';

/** Page.dc.html — a living page with citations and its sources rail. */
export function PageView() {
  const { id = '' } = useParams();
  const page = useQuery((c) => c.getPage(id), [id]);
  const spaceId = page.data?.spaceId ?? '';
  const space = useQuery((c) => (spaceId ? c.getSpace(spaceId) : Promise.resolve(undefined)), [spaceId]);
  const grants = useQuery((c) => (spaceId ? c.listGrants({ type: 'space', id: spaceId }) : Promise.resolve([])), [spaceId]);
  const [editing, setEditing] = useState(false);
  const [lit, setLit] = useState<number | null>(null);

  if (page.error) {
    return (
      <main className="main main--page">
        <ErrorNote error={page.error} />
      </main>
    );
  }
  if (!page.data) {
    return (
      <main className="main main--page" aria-busy="true">
        <Loading />
      </main>
    );
  }

  const p = page.data;
  const crumbs = (space.data?.name ?? '').split(' / ').filter(Boolean);
  const reader = space.data?.myRole === 'reader';
  const cite = { lit, onLight: setLit };

  return (
    <main className="main main--page">
      <article className="page">
        <nav className="page__crumbs mono" aria-label="Breadcrumb">
          {crumbs.map((c) => (
            <Fragment key={c}>
              <Link to={`/spaces/${spaceId}`} className="quiet-link">
                {c}
              </Link>
              <Icon name="chev" size={11} />
            </Fragment>
          ))}
          <Link to={`/spaces/${spaceId}`} className="quiet-link">
            pages
          </Link>
        </nav>
        <PreviewBadge area="pages" />
        <div className="titlebar">
          <h1 className="h1">{p.title}</h1>
          {!reader && (
            <button type="button" className="btn btn--pill" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
        <div className="page__meta mono">
          <span>
            kept up to date from {p.sessionCount} {p.sessionCount === 1 ? 'session' : 'sessions'}
          </span>
          <span>last change {relativeDayTime(p.updatedAt)}</span>
          <span className="with-icon">
            <Icon name="lock" size={12} />
            {accessSummary(grants.data ?? [])}
          </span>
        </div>
        <ReadOnlyNote space={space.data} />
        <div className="rule" />
        {p.sections.map((sec) => (
          <section key={sec.id} className={`page__section${sec.fork ? ' page__section--fork' : ''}`}>
            <h2>{sec.heading}</h2>
            {sec.spans.length > 0 && (
              <p contentEditable={editing} suppressContentEditableWarning className={editing ? 'is-editing' : undefined}>
                {sec.spans.map((span, i) => (
                  <Fragment key={i}>
                    {span.struck ? <s>{span.text}</s> : span.text}
                    <Cites ns={span.cites} {...cite} />
                  </Fragment>
                ))}
              </p>
            )}
            {sec.fork && <ForkBlock fork={sec.fork} {...cite} />}
            {sec.changes && sec.changes.length > 0 && <ChangesBlock changes={sec.changes} {...cite} />}
            {sec.facts && sec.facts.length > 0 && <FactsBlock facts={sec.facts} {...cite} />}
          </section>
        ))}
        {p.related && p.related.length > 0 && <RelatedPages related={p.related} />}
        <div className="grow" />
        <footer className="sfoot sfoot--page">
          <span className="sfoot__icon">
            <Icon name="spark" size={15} />
          </span>
          <span>Written and kept current by the model on your server. Your edits always win.</span>
        </footer>
      </article>
      <aside className="sources" aria-label="Sources">
        <h3 className="caps mono">Sources</h3>
        <ul className="plain">
          {p.citations.map((s) => (
            <li key={s.n} id={`source-${s.n}`}>
              <Link
                to={`/sessions/${s.sessionId}`}
                className={`src${lit === s.n ? ' is-lit' : ''}`}
                onMouseEnter={() => setLit(s.n)}
                onMouseLeave={() => setLit(null)}
              >
                <span className="src__n mono">{s.n}</span>
                <span className="src__icon">
                  <Icon name={SOURCE_ICON[s.source]} size={14} />
                </span>
                <span className="src__text">
                  <span className="src__title">{s.title}</span>
                  <span className="src__meta mono">{s.meta}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {p.contributors && p.contributors.length > 0 && <PagePeople people={p.contributors} />}
        <h3 className="caps mono" style={{ margin: '22px 0 8px' }}>
          Reached
        </h3>
        <p className="sources__reach">{p.reach}</p>
      </aside>
    </main>
  );
}
