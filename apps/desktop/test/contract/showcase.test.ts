// @vitest-environment node
/**
 * The sample workspace has to show every use case, and it must never leak into a
 * real account. These tests read the dataset the way the screens do (through
 * `OpenKTClient`), and check the http adapter against the fake server.
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/api/http';
import { MockClient } from '../../src/api/mock';
import { createSeed } from '../../src/api/mock/seed';
import { SHOWCASE_TEAMS } from '../../src/api/mock/showcase/build';
import type { ContextKind, SessionSource } from '../../src/api/types';
import { createFakeServer } from '../support/fake-server';

const EVERY_SOURCE: SessionSource[] = ['claude-code', 'codex', 'claude', 'chatgpt', 'cursor', 'meeting', 'voice', 'screenshot', 'note', 'connector'];
const EVERY_KIND: ContextKind[] = ['decision', 'fact', 'how-to', 'issue', 'question', 'action', 'idea'];

describe('sample workspace — every use case is in it', () => {
  const db = createSeed();

  it('has the six teams from the report, plus a personal space', async () => {
    const spaces = await new MockClient().listSpaces();
    expect(spaces.map((s) => s.name)).toEqual(['openkt', 'sales', 'healthcare', 'legal', 'marketing', 'hospitality', 'personal']);
    expect(spaces.filter((s) => s.personal)).toHaveLength(1);
  });

  it('shows access: you own some spaces, edit others, and only read one', async () => {
    const spaces = await new MockClient().listSpaces();
    const roles = spaces.filter((s) => !s.personal).map((s) => s.myRole);
    expect(roles.filter((r) => r === 'owner').length).toBeGreaterThanOrEqual(1);
    expect(roles.filter((r) => r === 'editor').length).toBeGreaterThanOrEqual(2);
    const readers = spaces.filter((s) => s.myRole === 'reader');
    expect(readers).toHaveLength(1);
    const owner = db.workspace.people.find((p) => p.id === readers[0]!.ownerId);
    expect(owner?.name).toBe('Dr. Ekwueme');
    // …and a reader cannot save into it.
    await expect(new MockClient().createSession({ source: 'note', title: 'x', spaceId: readers[0]!.id, text: 'x' })).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('has sessions from every capture path', () => {
    const sources = new Set(db.sessions.map((s) => s.source));
    for (const s of EVERY_SOURCE) expect(sources, s).toContain(s);
    expect(db.sessions.some((s) => s.source === 'claude' && s.via === 'Cowork')).toBe(true);
    expect(db.sessions.some((s) => s.source === 'connector' && s.via === 'Notion')).toBe(true);
  });

  it('a meeting has two speakers taking turns, and a screenshot keeps the text read off the image', () => {
    const meeting = db.sessions.find((s) => s.id === 's-sales-acmeflow')!;
    expect(new Set(meeting.turns.map((t) => t.speaker))).toEqual(new Set(['Tomas', 'Marcus']));
    expect(meeting.durationSec).toBeGreaterThan(60);
    const shots = db.sessions.filter((s) => s.source === 'screenshot');
    expect(shots.length).toBeGreaterThanOrEqual(2);
    for (const s of shots) expect(s.turns.some((t) => t.speaker === 'Text in image' && t.text.length > 20)).toBe(true);
  });

  it('every fact has an author, a kind and a session it can be traced to — and every kind is used', () => {
    const sessions = new Set(db.sessions.map((s) => s.id));
    for (const c of db.context) {
      expect(sessions.has(c.sessionId), c.id).toBe(true);
      expect(c.author, c.id).toBeTruthy();
      if (c.kind !== 'question') expect(db.workspace.people.some((p) => p.id === c.authorId), c.id).toBe(true);
      if (c.quote) expect(db.sessions.find((s) => s.id === c.sessionId)!.turns.some((t) => t.text.includes(c.quote!)), `quote of ${c.id}`).toBe(true);
    }
    const kinds = new Set(db.context.map((c) => c.kind));
    for (const k of EVERY_KIND) expect(kinds, k).toContain(k);
  });

  it('keeps the report’s words: every memory is a fact, verbatim', () => {
    const texts = new Set(db.context.map((c) => c.statement));
    let n = 0;
    for (const team of SHOWCASE_TEAMS) {
      for (const f of team.facts) {
        expect(texts.has(f.text), f.id).toBe(true);
        n += 1;
      }
      expect(team.facts).toHaveLength(team.stats.memories);
    }
    expect(n).toBe(213);
  });

  it.each(SHOWCASE_TEAMS.map((t) => [t.space.label, t.space.id] as const))('%s: pages with a fork, a change, people, relations — and a brief', async (_label, spaceId) => {
    const client = new MockClient();
    const list = await client.listPages(spaceId);
    const pages = await Promise.all(list.map((p) => client.getPage(p.id)));
    const brief = pages[0]!;
    expect(brief.title).toMatch(/ brief$/);

    const forks = pages.flatMap((p) => p.sections.filter((s) => s.fork).map((s) => s.fork!));
    expect(forks.length).toBeGreaterThanOrEqual(1);
    for (const f of forks) {
      expect(f.sides).toHaveLength(2);
      expect(f.sides[0]!.who).not.toBe(f.sides[1]!.who);
      for (const side of f.sides) expect(side.position.length).toBeGreaterThan(10);
    }
    const changes = pages.slice(1).flatMap((p) => p.sections.flatMap((s) => s.changes ?? []));
    expect(changes.length).toBeGreaterThanOrEqual(1);
    for (const c of changes) expect(c.was && c.now).toBeTruthy();
    // The superseded fact stays on its page, struck through.
    expect(pages.some((p) => p.sections.some((s) => s.facts?.some((f) => f.superseded)))).toBe(true);

    const ids = new Set(list.map((p) => p.id));
    for (const p of pages) {
      expect(p.contributors?.length, p.id).toBeGreaterThan(0);
      for (const r of p.related ?? []) expect(ids.has(r.id), `${p.id} → ${r.id}`).toBe(true);
      for (const c of p.citations) expect(await client.getSession(c.sessionId)).toBeTruthy();
      const cited = new Set(p.sections.flatMap((s) => [...s.spans.flatMap((x) => x.cites ?? []), ...(s.facts ?? []).flatMap((f) => f.cites)]));
      for (const n of cited) expect(p.citations.some((c) => c.n === n), `${p.id} cites ${n}`).toBe(true);
    }
    expect(pages.slice(1).some((p) => (p.related?.length ?? 0) > 0)).toBe(true);
  });

  it('the people panel says who contributed what, with the pages it feeds', async () => {
    const people = await new MockClient().listContributors('sp-sales');
    expect(people.map((p) => p.name).sort()).toEqual(['Dana', 'Greg', 'Marcus', 'Nadia', 'Priya', 'Tomas']);
    const dana = people.find((p) => p.name === 'Dana')!;
    expect(dana).toMatchObject({ title: 'VP Sales', facts: 8 });
    expect(dana.topics.map((t) => t.title)).toContain('Pricing Strategy & Deal Economics');
  });

  it('the knowledge graph links facts to pages, people to pages, and pages to each other', async () => {
    const g = await new MockClient().getKnowledgeGraph('sp-openkt');
    const count = (t: string) => g.nodes.filter((n) => n.type === t).length;
    expect([count('page'), count('person'), count('fact')]).toEqual([7, 3, 30]);
    expect(g.edges.filter((e) => e.type === 'relates').length).toBeGreaterThanOrEqual(6);
    expect(g.edges.every((e) => g.nodes.some((n) => n.id === e.from) && g.nodes.some((n) => n.id === e.to))).toBe(true);
  });

  it('skills are derived from every team’s knowledge', async () => {
    const skills = await new MockClient().listSkills();
    for (const t of SHOWCASE_TEAMS) expect(skills.some((s) => s.spaceId === t.space.id), t.space.name).toBe(true);
    expect(skills.map((s) => s.slug)).toEqual(expect.arrayContaining(['run-a-sales-discovery-call', 'start-the-sepsis-bundle', 'negotiate-the-liability-cap']));
  });

  it('search recalls across teams, with who said it and where, and marks what you can only read', async () => {
    const client = new MockClient();
    const acme = await client.recall('Acmeflow', { limit: 9 });
    const fact = acme.find((h) => h.type === 'context' && /NEVER lead with price/.test(h.title));
    expect(fact?.meta).toBe('Tomas · sales');
    expect(acme.some((h) => h.type === 'page')).toBe(true);
    expect(acme.some((h) => h.type === 'session' && h.title === 'Acmeflow deal review')).toBe(true);

    const glucose = await client.recall('glucose target', { limit: 9 });
    expect(glucose.filter((h) => h.type === 'context').length).toBeGreaterThan(1);
    for (const h of glucose) expect(h.meta).toMatch(/healthcare · read only/);

    const scoped = await client.recall('discount', { spaceId: 'sp-sales' });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((h) => h.meta.includes('sales'))).toBe(true);
  });
});

describe('signed in to a real server — never the sample', () => {
  const BASE = 'http://openkt.test';
  const fake = createFakeServer(BASE);
  const server = setupServer(...fake.handlers);
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('shows none of the sample spaces, sessions, pages, skills, people or search results', async () => {
    const client = new HttpClient({ baseUrl: BASE, token: fake.tokens.a });
    const sample = createSeed();
    const spaces = await client.listSpaces();
    expect(spaces.some((s) => sample.spaces.some((x) => x.id === s.id || (x.name === s.name && !x.personal)))).toBe(false);
    const sessions = await client.listSessions();
    expect(sessions.some((s) => sample.sessions.some((x) => x.id === s.id || x.title === s.title))).toBe(false);
    for (const s of spaces) expect(await client.listPages(s.id)).toEqual([]);
    await expect(client.getPage('p-sales-brief')).rejects.toThrow();
    await expect(client.getPage('p-sales-trial-poc-management')).rejects.toThrow();
    const skills = await client.listSkills();
    expect(skills.some((s) => sample.skills.some((x) => x.slug === s.slug))).toBe(false);
    expect(await client.recall('Acmeflow')).toEqual([]);
    const people = (await client.getWorkspace()).people.map((p) => p.name);
    expect(people).not.toContain('Dr. Ekwueme');
    expect(client.listContributors).toBeUndefined();
    expect(client.getKnowledgeGraph).toBeUndefined();
  });
});
