/**
 * Turns the team files into what the app reads: people, spaces, sessions (with
 * transcripts), facts, living pages (with forks, changes, relations and who said
 * what), one brief per space, and the grants that make each role visible.
 */
import { initialsOf, relativeDay, viaLabel } from '../../format';
import type {
  ContextItem,
  Grant,
  Id,
  Page,
  PageChange,
  PageContributor,
  PageFact,
  PageFork,
  PageRelation,
  PageSection,
  PageSource,
  Person,
  Session,
  Space,
  Team,
  Turn,
} from '../../types';
import { healthcare } from './healthcare';
import { hospitality } from './hospitality';
import { legal } from './legal';
import { marketing } from './marketing';
import { openkt } from './openkt';
import { sales } from './sales';
import type { ShowcaseFact, ShowcasePage, ShowcaseTeam } from './types';

/** In the order the report's tabs list them. */
export const SHOWCASE_TEAMS: readonly ShowcaseTeam[] = [openkt, sales, healthcare, legal, marketing, hospitality];

export interface BuiltShowcase {
  people: Person[];
  teams: Team[];
  spaces: Space[];
  sessions: Session[];
  context: ContextItem[];
  pages: Page[];
  grants: Grant[];
  /** Which page each fact feeds. */
  factPage: Record<Id, Id>;
}

/** The part of a statement a quote gate would keep: its opening clause or two, verbatim. */
export function quoteOf(text: string): string {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const ends = [...text.matchAll(/ — |; |: |, /g)].map((m) => m.index).concat(text.length);
  const end = ends.find((i) => words(text.slice(0, i)) >= 4) ?? text.length;
  const clause = text.slice(0, end);
  const cut = words(clause) <= 20 ? clause : clause.split(/\s+/).slice(0, 16).join(' ');
  return cut.replace(/[.;,:]+$/, '');
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function buildShowcase(me: Person, at: (daysAgo: number, hh: number, mm: number) => string): BuiltShowcase {
  const people = new Map<string, Person>();
  const idOf = (key: string): Id => (key === 'me' ? me.id : `u-${key}`);
  const nameOf = (key: string): string => (key === 'me' ? (me.name.split(' ')[0] ?? me.name) : (people.get(key)?.name ?? key));

  const out: BuiltShowcase = { people: [], teams: [], spaces: [], sessions: [], context: [], pages: [], grants: [], factPage: {} };

  for (const team of SHOWCASE_TEAMS) {
    const { space: def } = team;
    for (const p of team.people) {
      if (p.key === 'me') continue;
      const existing = people.get(p.key);
      if (existing && existing.name !== p.name) throw new Error(`person key ${p.key} is taken`);
      const person: Person = { id: idOf(p.key), name: p.name, initials: initialsOf(p.name), email: `${p.key.replace(/-/g, '.')}@example.com`, title: p.title };
      people.set(p.key, person);
      out.people.push(person);
    }
    const members = team.people.map((p) => p.key);
    if (!members.includes('me')) members.push('me');
    out.teams.push({ id: def.team[0], name: def.team[1], memberCount: members.length });

    const facts = new Map(team.facts.map((f) => [f.id, f]));
    const sessionOf = new Map<string, Session>();
    const factItems = new Map<string, ContextItem>();

    // ── sessions and their facts ──
    for (const s of team.sessions) {
      const [hh, mm] = s.time.split(':').map(Number) as [number, number];
      const createdAt = at(s.day, hh, mm);
      const said = s.facts.map((id) => {
        const f = facts.get(id);
        if (!f) throw new Error(`${s.id}: no fact ${id}`);
        return f;
      });
      const turns: Turn[] = [];
      if (s.shot) {
        turns.push({ id: 't0', speaker: nameOf(s.by), at: 0, text: s.shot.caption });
        turns.push({ id: 't0b', speaker: 'Text in image', at: 0, text: s.shot.text });
      }
      said.forEach((f, i) => {
        const offset = s.source === 'meeting' && s.durationSec ? Math.round(((i + 0.5) * s.durationSec) / said.length) : s.source === 'voice' ? i * 12 : 0;
        turns.push({ id: `t${i + 1}`, speaker: nameOf(f.by), at: offset, text: f.text });
      });
      const session: Session = {
        id: s.id,
        source: s.source,
        ...(s.via ? { via: s.via } : {}),
        title: s.title,
        summary: said
          .slice(0, 2)
          .map((f) => f.text)
          .join(' '),
        status: 'closed',
        spaceId: def.id,
        authorId: idOf(s.by),
        createdAt,
        ...(s.durationSec ? { durationSec: s.durationSec } : {}),
        extractedOn: ['meeting', 'voice', 'screenshot', 'note'].includes(s.source) ? 'device' : 'server',
        turns,
      };
      out.sessions.push(session);
      said.forEach((f, i) => {
        sessionOf.set(f.id, session);
        const item: ContextItem = {
          id: f.id,
          kind: f.kind,
          statement: f.text,
          quote: quoteOf(f.text),
          author: nameOf(f.by),
          authorId: idOf(f.by),
          sessionId: session.id,
          spaceId: def.id,
          tags: [tagOf(team, f.page)],
          createdAt: new Date(Date.parse(createdAt) + (i + 1) * 60_000 + (session.durationSec ?? 0) * 1000).toISOString(),
          ...(f.supersededBy ? { supersededBy: f.supersededBy } : {}),
        };
        factItems.set(f.id, item);
        out.context.push(item);
        out.factPage[f.id] = f.page;
      });
      if (s.question) {
        out.context.push({
          id: `${s.id}-q`,
          kind: 'question',
          statement: s.question,
          author: 'open',
          sessionId: session.id,
          spaceId: def.id,
          tags: ['open disagreement'],
          createdAt: new Date(Date.parse(createdAt) + (said.length + 1) * 60_000 + (session.durationSec ?? 0) * 1000).toISOString(),
        });
      }
    }

    // ── living pages ──
    const pageTitle = new Map(team.pages.map((p) => [p.id, p.title]));
    const built: Page[] = team.pages.map((p) => buildPage(team, p, { facts, factItems, sessionOf, nameOf, pageTitle }));

    // ── the space's brief ──
    const brief = buildBrief(team, built, { factItems, sessionOf, nameOf, people });
    out.pages.push(brief, ...built);

    const sessions = out.sessions.filter((s) => s.spaceId === def.id);
    out.spaces.push({
      id: def.id,
      name: def.name,
      slug: def.name,
      description: def.description,
      memberCount: members.length,
      pageCount: built.length + 1,
      sessionCount: sessions.length,
      updatedAt: sessions.map((s) => s.createdAt).sort().at(-1) ?? at(0, 9, 0),
      ownerId: idOf(def.owner),
      myRole: def.myRole,
    });

    // ── grants: the owner, you, and everyone else on the team ──
    const subject = (key: string) => {
      const p = key === 'me' ? me : people.get(key)!;
      return { type: 'user' as const, id: p.id, name: p.name, initials: p.initials, email: p.email };
    };
    const space = { type: 'space' as const, id: def.id };
    out.grants.push({ id: `g-${def.id}-owner`, resource: space, subject: subject(def.owner), role: 'owner', note: def.owner === 'me' ? 'you · created this space' : 'created this space' });
    for (const key of members) {
      if (key === def.owner) continue;
      const title = team.people.find((p) => p.key === key)?.title ?? '';
      out.grants.push({ id: `g-${def.id}-${key}`, resource: space, subject: subject(key), role: key === 'me' ? def.myRole : 'editor', note: key === 'me' ? 'you' : title });
    }
    const teamSubject = { type: 'team' as const, id: def.team[0], name: def.team[1], initials: initialsOf(def.team[1]) };
    for (const s of sessions) {
      const by = team.sessions.find((x) => x.id === s.id)!.by;
      const verb = s.source === 'meeting' ? 'recorded' : s.source === 'connector' ? 'imported' : 'saved';
      out.grants.push({ id: `g-${s.id}-owner`, resource: { type: 'session', id: s.id }, subject: subject(by), role: 'owner', note: `${by === 'me' ? 'you · ' : ''}${verb} this session` });
      out.grants.push({
        id: `g-${s.id}-team`,
        resource: { type: 'session', id: s.id },
        subject: teamSubject,
        role: 'reader',
        note: `${plural(members.length, 'person', 'people')} · inherited from space ${def.name}`,
        inherited: true,
      });
    }
  }
  return out;
}

function tagOf(team: ShowcaseTeam, pageId: string): string {
  const title = team.pages.find((p) => p.id === pageId)?.title ?? '';
  return (title.split(/ & |: | vs\.? /)[0] ?? title).toLowerCase();
}

interface PageCtx {
  facts: Map<string, ShowcaseFact>;
  factItems: Map<string, ContextItem>;
  sessionOf: Map<string, Session>;
  nameOf: (key: string) => string;
  pageTitle: Map<string, string>;
}

/** Numbers each cited session once, in the order the page first cites it. */
class Citations {
  readonly sources: PageSource[] = [];
  private byId = new Map<Id, number>();
  constructor(
    private sessionOf: Map<string, Session>,
    private nameOf: (key: string) => string,
    private authorKey: (s: Session) => string,
  ) {}
  cite(factIds: (string | undefined)[]): number[] {
    const out: number[] = [];
    for (const id of factIds) {
      const s = id ? this.sessionOf.get(id) : undefined;
      if (!s) continue;
      let n = this.byId.get(s.id);
      if (n === undefined) {
        n = this.sources.length + 1;
        this.byId.set(s.id, n);
        this.sources.push({ n, sessionId: s.id, source: s.source, title: s.title, meta: `${this.nameOf(this.authorKey(s))} · ${viaLabel(s)} · ${relativeDay(s.createdAt)}` });
      }
      if (!out.includes(n)) out.push(n);
    }
    return out;
  }
}

const sessionAuthorKey = (team: ShowcaseTeam) => (s: Session) => team.sessions.find((x) => x.id === s.id)?.by ?? 'me';

function buildPage(team: ShowcaseTeam, p: ShowcasePage, ctx: PageCtx): Page {
  const cites = new Citations(ctx.sessionOf, ctx.nameOf, sessionAuthorKey(team));
  const sections: PageSection[] = [];

  sections.push({
    id: 'stands',
    heading: 'Where it stands',
    spans: p.stands.map(([text, facts], i) => ({ text: `${i ? ' ' : ''}${text}`, cites: cites.cite(facts) })),
  });

  (p.forks ?? []).forEach((f, i) => {
    sections.push({ id: `fork-${i + 1}`, heading: f.topic, spans: [], fork: forkOf(f, cites, ctx.nameOf) });
  });

  if (p.changes?.length) {
    sections.push({ id: 'changes', heading: 'What changed', spans: [], changes: p.changes.map((c) => changeOf(c, cites)) });
  }

  const own = team.facts.filter((f) => f.page === p.id);
  const order = [...p.by, ...own.map((f) => f.by).filter((k) => !p.by.includes(k))];
  const byPerson = [...own].sort((a, b) => order.indexOf(a.by) - order.indexOf(b.by) || (ctx.factItems.get(a.id)!.createdAt < ctx.factItems.get(b.id)!.createdAt ? -1 : 1));
  sections.push({ id: 'facts', heading: 'Who said what', spans: [], facts: byPerson.map((f) => factOf(f, cites, ctx)) });

  const related = relationsOf(p, ctx.pageTitle);
  const contributors: PageContributor[] = [...new Set(order)].map((key) => ({
    name: ctx.nameOf(key),
    title: team.people.find((x) => x.key === key)?.title,
    facts: own.filter((f) => f.by === key).length,
  }));
  const updatedAt = own.map((f) => ctx.factItems.get(f.id)!.createdAt).sort().at(-1) ?? new Date().toISOString();
  const sessions = new Set(own.map((f) => ctx.sessionOf.get(f.id)?.id));

  return {
    id: p.id,
    spaceId: team.space.id,
    title: p.title,
    summary: p.stands[0]?.[0] ?? '',
    sessionCount: cites.sources.length,
    updatedAt,
    sections,
    citations: cites.sources,
    reach: `Built from ${plural(own.length, 'fact')} in ${plural(sessions.size, 'session')}, said by ${plural(contributors.length, 'person', 'people')}.`,
    related,
    contributors,
  };
}

function forkOf(f: NonNullable<ShowcasePage['forks']>[number], cites: Citations, nameOf: (key: string) => string): PageFork {
  return { topic: f.topic, sides: f.sides.map(([who, position, fact]) => ({ who: nameOf(who), position, cites: cites.cite([fact]) })) };
}

function changeOf(c: NonNullable<ShowcasePage['changes']>[number], cites: Citations): PageChange {
  return { topic: c.topic, now: c.now, was: c.was, cites: cites.cite([c.nowFact]), wasCites: cites.cite([c.wasFact]) };
}

function factOf(f: ShowcaseFact, cites: Citations, ctx: PageCtx): PageFact {
  return { id: f.id, kind: f.kind, statement: f.text, author: ctx.nameOf(f.by), cites: cites.cite([f.id]), ...(f.supersededBy ? { superseded: true } : {}) };
}

/** Both directions of every relation, one row per page; two reasons for the same pair are joined. */
function relationsOf(p: ShowcasePage, titles: Map<string, string>): PageRelation[] {
  const rows = new Map<string, PageRelation>();
  for (const [id, why] of p.related ?? []) {
    const had = rows.get(id);
    if (had) had.why = `${had.why}. ${why}`;
    else rows.set(id, { id, title: titles.get(id) ?? id, why });
  }
  return [...rows.values()];
}

function buildBrief(
  team: ShowcaseTeam,
  pages: Page[],
  ctx: { factItems: Map<string, ContextItem>; sessionOf: Map<string, Session>; nameOf: (key: string) => string; people: Map<string, Person> },
): Page {
  const { space, stats } = team;
  const cites = new Citations(ctx.sessionOf, ctx.nameOf, sessionAuthorKey(team));
  const forks: PageFork[] = [];
  const changes: PageChange[] = [];
  for (const def of team.pages) {
    for (const f of def.forks ?? []) forks.push({ ...forkOf(f, cites, ctx.nameOf), pageId: def.id, pageTitle: def.title });
  }
  for (const def of team.pages) {
    for (const c of def.changes ?? []) changes.push({ ...changeOf(c, cites), pageId: def.id, pageTitle: def.title });
  }
  const newest = [...team.facts]
    .filter((f) => !f.supersededBy)
    .sort((a, b) => (ctx.factItems.get(b.id)!.createdAt < ctx.factItems.get(a.id)!.createdAt ? -1 : 1))
    .slice(0, 5);

  const sections: PageSection[] = [
    {
      id: 'brief',
      heading: 'In short',
      spans: [
        { text: `${space.description} ${stats.memories} memories from ${plural(stats.people, 'person', 'people')}, kept as ${plural(stats.pages, 'page')}. ` },
        { text: `${plural(forks.length, 'question is', 'questions are')} still open between two people, and ${plural(changes.length, 'position has', 'positions have')} changed.` },
      ],
    },
    ...forks.map((fork, i) => ({ id: `fork-${i + 1}`, heading: fork.topic, spans: [], fork })),
    { id: 'changes', heading: 'What changed', spans: [], changes },
    {
      id: 'newest',
      heading: 'Newest',
      spans: [],
      facts: newest.map((f) => ({ id: f.id, kind: f.kind, statement: f.text, author: ctx.nameOf(f.by), cites: cites.cite([f.id]) })),
    },
  ];
  const counts = new Map<string, number>();
  for (const f of team.facts) counts.set(f.by, (counts.get(f.by) ?? 0) + 1);
  const contributors: PageContributor[] = team.people
    .map((p) => ({ name: ctx.nameOf(p.key), title: p.title, facts: counts.get(p.key) ?? 0 }))
    .sort((a, b) => b.facts - a.facts);

  return {
    id: `p-${space.name}-brief`,
    spaceId: space.id,
    title: `${space.label} brief`,
    summary: `${plural(stats.pages, 'page')} from ${plural(stats.people, 'person', 'people')} · ${plural(forks.length, 'open disagreement')} · ${plural(changes.length, 'change')}`,
    sessionCount: cites.sources.length,
    updatedAt: pages.map((p) => p.updatedAt).sort().at(-1) ?? new Date().toISOString(),
    sections,
    citations: cites.sources,
    reach: `A summary of ${plural(pages.length, 'page')} in ${space.name}. Kept current as they change.`,
    related: pages.map((p) => ({ id: p.id, title: p.title, why: p.summary })),
    contributors,
  };
}
