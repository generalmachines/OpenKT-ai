import { Link } from 'react-router-dom';
import { initialsOf } from '../api/format';
import type { PageChange, PageContributor, PageFact, PageFork, PageRelation } from '../api/types';
import { Avatar, KindChip } from './bits';

/** Superscript source numbers; hovering one lights its row in the Sources rail. */
export function Cites({ ns, lit, onLight }: { ns?: number[]; lit: number | null; onLight: (n: number | null) => void }) {
  if (!ns?.length) return null;
  return (
    <>
      {ns.map((n) => (
        <sup key={n} className={`cite mono${lit === n ? ' is-lit' : ''}`} onMouseEnter={() => onLight(n)} onMouseLeave={() => onLight(null)}>
          <a href={`#source-${n}`} aria-label={`Source ${n}`}>
            {n}
          </a>
        </sup>
      ))}
    </>
  );
}

interface Lit {
  lit: number | null;
  onLight: (n: number | null) => void;
}

/** ⑂ Two people hold different positions. Both stay on the page, attributed, until the team settles it. */
export function ForkBlock({ fork, ...cite }: { fork: PageFork } & Lit) {
  return (
    <div className="fork" role="group" aria-label={`Open disagreement: ${fork.topic}`}>
      <div className="fork__label mono">
        <span aria-hidden="true">⑂</span> fork · both positions stand
      </div>
      <div className="fork__sides">
        {fork.sides.map((side) => (
          <div key={side.who} className="fork__side">
            <span className="fork__who">
              <Avatar initials={initialsOf(side.who)} size={22} fontSize={9} />
              {side.who}
            </span>
            <p className="fork__position">
              {side.position}
              <Cites ns={side.cites} {...cite} />
            </p>
          </div>
        ))}
      </div>
      {fork.pageId && (
        <Link to={`/pages/${fork.pageId}`} className="fork__from mono quiet-link">
          on {fork.pageTitle} →
        </Link>
      )}
    </div>
  );
}

/** ⟳ What the team believes now, and — struck through — what it believed before. */
export function ChangesBlock({ changes, ...cite }: { changes: PageChange[] } & Lit) {
  return (
    <ul className="plain changes" aria-label="What changed">
      {changes.map((c) => (
        <li key={`${c.pageId ?? ''}${c.topic}`} className="change">
          <span className="change__topic mono">
            <span aria-hidden="true">⟳</span> {c.topic}
            {c.pageId && (
              <>
                {' · '}
                <Link to={`/pages/${c.pageId}`} className="quiet-link">
                  {c.pageTitle}
                </Link>
              </>
            )}
          </span>
          <span className="change__now">
            <span className="change__tag mono">now</span>
            <span>
              {c.now}
              <Cites ns={c.cites} {...cite} />
            </span>
          </span>
          <span className="change__was">
            <span className="change__tag mono">was</span>
            <span>
              <s>{c.was}</s>
              <Cites ns={c.wasCites} {...cite} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The facts under a page, each with its kind and who said it. Superseded ones stay, struck through. */
export function FactsBlock({ facts, ...cite }: { facts: PageFact[] } & Lit) {
  return (
    <ul className="plain pfacts">
      {facts.map((f) => (
        <li key={f.id} className={`pfact${f.superseded ? ' is-superseded' : ''}`}>
          <KindChip kind={f.kind} />
          <span className="pfact__text">
            {f.superseded ? <s>{f.statement}</s> : f.statement}
            <Cites ns={f.cites} {...cite} />
            {f.superseded && <span className="pfact__note mono"> superseded</span>}
          </span>
          <span className="pfact__who mono">{f.author}</span>
        </li>
      ))}
    </ul>
  );
}

export function RelatedPages({ related }: { related: PageRelation[] }) {
  return (
    <section className="page__section related" aria-label="Related pages">
      <h2>Related pages</h2>
      <ul className="plain">
        {related.map((r) => (
          <li key={r.id}>
            <Link to={`/pages/${r.id}`} className="related__row">
              <span className="related__title">{r.title} →</span>
              <span className="related__why">{r.why}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The rail's "People": whose context this page is built from. */
export function PagePeople({ people }: { people: PageContributor[] }) {
  return (
    <>
      <h3 className="caps mono" style={{ margin: '22px 0 8px' }}>
        People
      </h3>
      <ul className="plain" aria-label="People on this page">
        {people.map((p) => (
          <li key={p.name} className="ppl">
            <Avatar initials={initialsOf(p.name)} size={24} fontSize={9} />
            <span className="ppl__text">
              <span className="ppl__name">{p.name}</span>
              <span className="ppl__meta mono">{[p.title, `${p.facts} ${p.facts === 1 ? 'fact' : 'facts'}`].filter(Boolean).join(' · ')}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
