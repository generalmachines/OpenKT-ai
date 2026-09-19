import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { describeError } from '../api/errors';
import { accessSummary, relativeDayTime } from '../api/format';
import { useClient, useQuery } from '../api/hooks';
import { toStoredMarkdown } from '../api/pages';
import type { PageSection } from '../api/types';
import { ErrorNote, Loading } from '../components/bits';
import { Icon, SOURCE_ICON } from '../components/Icon';
import { ChangesBlock, Cites, FactsBlock, ForkBlock, PagePeople, RelatedPages } from '../components/PageBlocks';
import { PreviewBadge } from '../components/PreviewBadge';
import { ReadOnlyNote } from '../components/ReadOnlyNote';

/** The text a person edits: the section's markdown with `[^n]` markers (sample sections: rebuilt from spans). */
function editableText(sec: PageSection): string {
  if (sec.markdown !== undefined) return sec.markdown;
  return sec.spans.map((sp) => `${sp.text}${(sp.cites ?? []).map((n) => `[^${n}]`).join('')}`).join('');
}

/** One section in edit mode: a plain text box. Saving locks it — agents never rewrite it again. */
function SectionEditor({ pageId, sec, onDone }: { pageId: string; sec: PageSection; onDone: () => void }) {
  const client = useClient();
  const [text, setText] = useState(() => editableText(sec));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.editPageSection(pageId, sec.id, toStoredMarkdown(text, sec.citationMap ?? []));
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page__edit">
      <label className="sr-only" htmlFor={`edit-${sec.id}`}>
        {sec.heading}
      </label>
      <textarea id={`edit-${sec.id}`} className="input page__textarea" value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(4, text.split('\n').length + 2))} />
      <p className="page__hint mono">[^1] marks a source. Once you save, this section is yours: the model adds new facts under Updates instead.</p>
      {error && (
        <p className="page__hint page__hint--error" role="alert">
          {error}
        </p>
      )}
      <div className="page__edit-actions">
        <button type="button" className="btn btn--pill" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--pill btn--dark" onClick={() => void save()} disabled={busy || text.trim() === editableText(sec).trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/** A server section: paragraphs, then list items grouped into one list. */
function SectionBlocks({ sec, cite }: { sec: PageSection; cite: { lit: number | null; onLight: (n: number | null) => void } }) {
  const groups: { kind: 'p' | 'li'; items: NonNullable<PageSection['blocks']> }[] = [];
  for (const b of sec.blocks ?? []) {
    const last = groups[groups.length - 1];
    if (b.kind === 'li' && last?.kind === 'li') last.items.push(b);
    else groups.push({ kind: b.kind, items: [b] });
  }
  const spans = (b: NonNullable<PageSection['blocks']>[number]) =>
    b.spans.map((span, i) => (
      <Fragment key={i}>
        {span.struck ? <s>{span.text}</s> : span.text}
        <Cites ns={span.cites} {...cite} />
      </Fragment>
    ));
  return (
    <>
      {groups.map((g, i) =>
        g.kind === 'li' ? (
          <ul key={i} className="page__list">
            {g.items.map((b, j) => (
              <li key={j}>{spans(b)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{spans(g.items[0]!)}</p>
        ),
      )}
    </>
  );
}

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
            <h2>
              {sec.heading}
              {sec.locked && <span className="page__locked mono">edited by a person</span>}
            </h2>
            {editing && !sec.fork ? (
              <SectionEditor pageId={p.id} sec={sec} onDone={() => page.reload()} />
            ) : sec.blocks ? (
              <SectionBlocks sec={sec} cite={cite} />
            ) : (
              sec.spans.length > 0 && (
                <p>
                  {sec.spans.map((span, i) => (
                    <Fragment key={i}>
                      {span.struck ? <s>{span.text}</s> : span.text}
                      <Cites ns={span.cites} {...cite} />
                    </Fragment>
                  ))}
                </p>
              )
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
          <span>Written and kept current by on-device AI on your team’s Macs. Your edits always win.</span>
        </footer>
      </article>
      <aside className="sources" aria-label="Sources">
        <h3 className="caps mono">Sources</h3>
        <ul className="plain">
          {p.citations.map((s) => (
            <li key={s.n} id={`source-${s.n}`}>
              {(() => {
                const inner = (
                  <>
                    <span className="src__n mono">{s.n}</span>
                    <span className="src__icon">
                      <Icon name={SOURCE_ICON[s.source]} size={14} />
                    </span>
                    <span className="src__text">
                      <span className="src__title">{s.title}</span>
                      <span className="src__meta mono">{s.meta}</span>
                    </span>
                  </>
                );
                const props = { className: `src${lit === s.n ? ' is-lit' : ''}`, onMouseEnter: () => setLit(s.n), onMouseLeave: () => setLit(null) };
                // A fact saved outside a session, or a session this person cannot open: no link.
                return s.sessionId ? (
                  <Link to={`/sessions/${s.sessionId}`} {...props}>
                    {inner}
                  </Link>
                ) : (
                  <span {...props}>{inner}</span>
                );
              })()}
            </li>
          ))}
        </ul>
        {p.contributors && p.contributors.length > 0 && <PagePeople people={p.contributors} />}
        {p.reach && (
          <>
            <h3 className="caps mono" style={{ margin: '22px 0 8px' }}>
              Reached
            </h3>
            <p className="sources__reach">{p.reach}</p>
          </>
        )}
      </aside>
    </main>
  );
}
