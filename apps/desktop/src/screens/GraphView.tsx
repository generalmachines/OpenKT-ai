import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useClient, useQuery } from '../api/hooks';
import type { KnowledgeGraph } from '../api/types';
import { ErrorNote, Loading } from '../components/bits';
import { layout, type Placed } from '../components/graph/layout';

/** The canvas is drawn at the size it is shown, so labels stay at their real size. */
function useSize(fallback: { w: number; h: number }) {
  // A callback ref: the stage mounts only once the graph has loaded.
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r && r.width > 100 && r.height > 100)
        setSize((s) => (Math.abs(s.w - r.width) > 4 || Math.abs(s.h - r.height) > 4 ? { w: Math.round(r.width), h: Math.round(r.height) } : s));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, size] as const;
}

/** Muted page colours; facts take the colour of the page they feed. */
const PALETTE = ['#b4532a', '#4f6471', '#4f7a4a', '#9b771a', '#7a5a8c', '#3f6a8a', '#8f5a3a', '#5f7f6a', '#a0624e', '#6b6a8f', '#7a7a3a', '#4a7070'];

const TYPE_LABEL: Record<Placed['type'], string> = {
  fact: 'fact',
  page: 'page',
  person: 'person',
};

function wrap(text: string, width = 22, lines = 2): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1]!.replace(/[\s&:,]+$/, '')}…`;
    return kept;
  }
  return out;
}

function Node({ n, color, dim, selected, onSelect }: { n: Placed; color: string; dim: boolean; selected: boolean; onSelect: () => void }) {
  const common = {
    role: 'button',
    tabIndex: 0,
    'aria-label': `${TYPE_LABEL[n.type]}: ${n.label}`,
    'aria-pressed': selected,
    className: `gnode gnode--${n.type}${dim ? ' is-dim' : ''}${selected ? ' is-selected' : ''}`,
    onClick: onSelect,
    onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect()),
  } as const;
  if (n.type === 'fact') {
    return (
      <g {...common} transform={`translate(${n.x},${n.y})`}>
        <title>{n.label}</title>
        <circle r={9} fill="transparent" />
        <circle r={selected ? 6.5 : 4.6} fill={n.superseded ? 'var(--bg)' : color} stroke={color} strokeWidth={n.superseded ? 1.4 : 0} fillOpacity={0.85} />
      </g>
    );
  }
  if (n.type === 'person') {
    return (
      <g {...common} transform={`translate(${n.x},${n.y})`}>
        <rect x={-34} y={-11} width={68} height={38} fill="transparent" />
        <path d="M0 -8 L8 0 L0 8 L-8 0 Z" className="gnode__diamond" />
        <text y={21} textAnchor="middle" className="gnode__name">
          {n.label}
        </text>
      </g>
    );
  }
  const lines = wrap(n.label);
  const w = Math.max(...lines.map((l) => l.length)) * 6.1 + 18;
  const h = lines.length * 13 + 11;
  return (
    <g {...common} transform={`translate(${n.x},${n.y})`}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={6} fill="var(--bg)" />
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={6} fill={color} fillOpacity={0.1} stroke={color} strokeWidth={selected ? 1.8 : 1} />
      {lines.map((l, i) => (
        <text key={i} y={-h / 2 + 15 + i * 13} textAnchor="middle" className="gnode__label">
          {l}
        </text>
      ))}
    </g>
  );
}

/** How a space's people, pages and facts connect. Click anything to read it; open it from the panel. */
export function GraphView() {
  const { id = '' } = useParams();
  const client = useClient();
  const space = useQuery((c) => c.getSpace(id), [id]);
  const graph = useQuery((c) => (c.getKnowledgeGraph ? c.getKnowledgeGraph(id) : Promise.resolve<KnowledgeGraph | null>(null)), [id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [stage, { w: W, h: H }] = useSize({ w: 640, h: 480 });
  const placed = useMemo(() => (graph.data ? layout(graph.data, W, H) : []), [graph.data, W, H]);
  const byId = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);
  const colors = useMemo(() => {
    const m = new Map<string, string>();
    placed.filter((n) => n.type === 'page').forEach((n, i) => m.set(n.id, PALETTE[i % PALETTE.length]!));
    return m;
  }, [placed]);

  const near = useMemo(() => {
    if (!selected || !graph.data) return null;
    const s = new Set([selected]);
    for (const e of graph.data.edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    // A person lights up what they said, too.
    for (const n of graph.data.nodes) if (n.personId === selected) s.add(n.id);
    return s;
  }, [selected, graph.data]);

  const pick = selected ? byId.get(selected) : undefined;
  const related = pick && graph.data ? graph.data.edges.filter((e) => e.type === 'relates' && (e.from === pick.id || e.to === pick.id)) : [];
  const pagesOf = pick?.type === 'person' && graph.data ? graph.data.edges.filter((e) => e.type === 'contributes' && e.from === pick.id).map((e) => byId.get(e.to)) : [];

  return (
    <main className="main main--space main--graph">
      <div className="titlebar">
        <div className="titlebar__stack">
          <span className="mono crumb">
            <Link to="/spaces" className="quiet-link">
              space
            </Link>
            {' · '}
            <Link to={`/spaces/${id}`} className="quiet-link">
              {space.data?.name ?? ''}
            </Link>
          </span>
          <h1 className="h1">Knowledge graph</h1>
        </div>
      </div>
      {!client.getKnowledgeGraph ? (
        <p className="empty">The graph needs a server that keeps living pages. It appears here once yours does.</p>
      ) : graph.error ? (
        <ErrorNote error={graph.error} />
      ) : !graph.data ? (
        <Loading />
      ) : (
        <>
          <p className="graph__legend mono">
            <span>
              <span className="graph__key graph__key--fact" /> fact
            </span>
            <span>
              <span className="graph__key graph__key--page" /> page
            </span>
            <span>
              <span className="graph__key graph__key--person" /> person
            </span>
            <span>
              <span className="graph__key graph__key--relates" /> related pages
            </span>
            <span className="graph__hint">click anything to read it</span>
          </p>
          <div className="graph">
            <div className="graph__stage" ref={stage}>
              <svg
                width={W}
                height={H}
                viewBox={`0 0 ${W} ${H}`}
                className="graph__canvas"
                role="group"
                aria-label={`Knowledge graph of ${space.data?.name ?? 'this space'}`}
                onClick={(e) => e.target === e.currentTarget && setSelected(null)}
              >
                {graph.data.edges.map((e, i) => {
                  const a = byId.get(e.from);
                  const b = byId.get(e.to);
                  if (!a || !b) return null;
                  const on = near ? near.has(e.from) && near.has(e.to) && (e.from === selected || e.to === selected) : false;
                  return (
                    <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`gedge gedge--${e.type}${on ? ' is-on' : ''}${near && !on ? ' is-dim' : ''}`}>
                      {e.label && <title>{e.label}</title>}
                    </line>
                  );
                })}
                {[...placed]
                  .sort((a, b) => (a.type === 'fact' ? -1 : 0) - (b.type === 'fact' ? -1 : 0))
                  .map((n) => (
                    <Node
                      key={n.id}
                      n={n}
                      color={colors.get(n.type === 'page' ? n.id : (n.pageId ?? '')) ?? 'var(--ink-3)'}
                      dim={Boolean(near && !near.has(n.id))}
                      selected={n.id === selected}
                      onSelect={() => setSelected(n.id === selected ? null : n.id)}
                    />
                  ))}
              </svg>
            </div>
            <aside className="graph__detail" aria-label="Selected" aria-live="polite">
              {pick ? (
                <>
                  <span className="caps mono">{TYPE_LABEL[pick.type]}</span>
                  <p className={`graph__title${pick.superseded ? ' is-superseded' : ''}`}>{pick.superseded ? <s>{pick.label}</s> : pick.label}</p>
                  <p className="graph__meta mono">{pick.superseded ? `${pick.detail} · superseded` : pick.detail}</p>
                  {pick.type === 'fact' && pick.pageId && (
                    <p className="graph__meta mono">
                      feeds{' '}
                      <Link to={`/pages/${pick.pageId}`} className="quiet-link">
                        {byId.get(pick.pageId)?.label}
                      </Link>
                    </p>
                  )}
                  {pagesOf.length > 0 && (
                    <ul className="plain graph__rel" aria-label="Contributes to">
                      {pagesOf.map((pg) =>
                        pg ? (
                          <li key={pg.id}>
                            <button type="button" className="linkbtn" onClick={() => setSelected(pg.id)}>
                              {pg.label}
                            </button>
                          </li>
                        ) : null,
                      )}
                    </ul>
                  )}
                  {related.length > 0 && (
                    <ul className="plain graph__rel">
                      {related.map((e) => {
                        const other = byId.get(e.from === pick.id ? e.to : e.from);
                        return (
                          <li key={`${e.from}-${e.to}`}>
                            <button type="button" className="linkbtn" onClick={() => setSelected(other?.id ?? null)}>
                              {other?.label}
                            </button>
                            <span className="graph__why">{e.label}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {pick.type !== 'person' && (
                    <Link to={pick.href} className="btn btn--pill graph__open">
                      {pick.type === 'fact' ? 'Open the session' : 'Open the page'}
                    </Link>
                  )}
                </>
              ) : (
                <p className="graph__empty">
                  A dot is a fact someone said, a box is a page it feeds, a diamond is a person. Lines between boxes are why two pages depend on each other.
                </p>
              )}
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
