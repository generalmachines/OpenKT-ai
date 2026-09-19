/**
 * Living pages as the server sends them (GET /v1/pages/:id) → the app's Page.
 *
 * The server numbers sources in order of first citation and writes `[^n]` in each section's
 * markdown; `sources[n]` says which session it came from and who said it. Editing goes the other
 * way: the person edits text with `[^n]` markers, and each marker becomes the facts that section
 * cited under that number again (`[^f:<uuid>]`), so their citations survive the edit.
 */
import { relativeDay, sourceLabel } from './format';
import type { Id, Page, PageBlock, PageListItem, PageSection, PageSource, PageSpan, SessionSource, SpaceBrief, SpaceProcessing } from './types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** "Text [^1] more [^2][^3]." → spans, each run of markers attached to the text before it. */
export function spansOf(line: string): PageSpan[] {
  const spans: PageSpan[] = [];
  let last = 0;
  for (const m of line.matchAll(/((?:\s*\[\^\d+\])+)/g)) {
    const text = line.slice(last, m.index);
    const cites = [...m[1]!.matchAll(/\[\^(\d+)\]/g)].map((x) => Number(x[1]));
    const prev = spans[spans.length - 1];
    if (text) spans.push({ text, cites });
    else if (prev) prev.cites = [...new Set([...(prev.cites ?? []), ...cites])];
    else spans.push({ text: '', cites });
    last = (m.index ?? 0) + m[1]!.length;
  }
  const tail = line.slice(last);
  if (tail) spans.push({ text: tail });
  return spans;
}

/** Paragraphs and list items of a section, each as spans. Blank lines separate paragraphs. */
export function blocksOf(markdown: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: 'p', spans: spansOf(para.join(' ')) });
    para = [];
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      endPara();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      blocks.push({ kind: 'li', spans: spansOf(item[1]!) });
    } else para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  endPara();
  return blocks;
}

/** A person's edit back to stored markdown: each `[^n]` becomes the facts this section cited as n. */
export function toStoredMarkdown(edited: string, citations: { factId: Id; n: number }[]): string {
  return edited.replace(/\[\^(\d+)\]/g, (_w, n: string) => {
    const ids = citations.filter((c) => c.n === Number(n)).map((c) => `[^f:${c.factId}]`);
    return ids.join('');
  });
}

const APP_SOURCES: readonly SessionSource[] = ['meeting', 'claude-code', 'cursor', 'chatgpt', 'claude', 'hermes', 'voice', 'screenshot', 'note'];
const appSource = (s: string): SessionSource => ((APP_SOURCES as readonly string[]).includes(s) ? (s as SessionSource) : s === 'mcp' ? 'claude-code' : 'note');

export function toPageSource(j: Json, now: Date = new Date()): PageSource {
  const n = num(j['n']);
  if (j['restricted'] === true) return { n, sessionId: '', source: 'note', title: 'A session you can’t open', meta: 'restricted' };
  const session = obj(j['session']);
  const author = str(obj(j['author'])['name'], str(obj(session['author'])['name'], 'Someone'));
  if (!str(session['id'])) {
    const first = obj(arr(j['facts'])[0]);
    return { n, sessionId: '', source: 'note', title: str(first['statement'], 'Saved directly'), meta: `${author} · saved directly` };
  }
  const source = appSource(str(session['source']));
  return {
    n,
    sessionId: str(session['id']),
    source,
    title: str(session['title'], 'Untitled session'),
    meta: [author, sourceLabel(source), relativeDay(str(session['started_at']), now)].filter(Boolean).join(' · '),
    author,
  };
}

export function toPage(j: Json, now: Date = new Date()): Page {
  const sections: PageSection[] = arr(j['sections']).map((s) => {
    const markdown = str(s['body_md']);
    const blocks = blocksOf(markdown);
    return {
      id: str(s['id']),
      heading: str(s['heading']),
      spans: [],
      blocks,
      markdown,
      locked: s['locked'] === true,
      citationMap: arr(s['citations']).map((c) => ({ factId: str(c['fact_id']), n: num(c['n']) })),
    };
  });
  const sources = arr(j['sources']).map((s) => toPageSource(s, now));
  const people = new Map<string, number>();
  for (const s of arr(j['sources'])) {
    const name = str(obj(s['author'])['name']);
    if (name) people.set(name, (people.get(name) ?? 0) + arr(s['facts']).length);
  }
  return {
    id: str(j['id']),
    spaceId: str(j['project_id']),
    title: str(j['title']),
    summary: str(j['summary']),
    sessionCount: num(j['session_count'], sources.filter((s) => s.sessionId).length),
    updatedAt: str(j['updated_at']),
    sections,
    citations: sources,
    reach: '',
    contributors: [...people.entries()].map(([name, facts]) => ({ name, facts })),
  };
}

export function toPageListItem(j: Json): PageListItem {
  return {
    id: str(j['id']),
    spaceId: str(j['project_id']),
    title: str(j['title']),
    summary: str(j['summary']),
    sessionCount: num(j['session_count']),
    updatedAt: str(j['updated_at']),
  };
}

export function toBrief(j: Json): SpaceBrief | null {
  const markdown = str(j['brief_md']);
  return markdown ? { markdown, updatedAt: str(j['updated_at']) } : null;
}

export function toProcessing(meta: Json): SpaceProcessing | null {
  const p = obj(meta['processing']);
  if (!Object.keys(p).length) return null;
  return {
    waiting: num(p['queued']),
    running: num(p['claimed']),
    failed: num(p['failed']),
    lastDoneAt: str(p['last_done_at']) || null,
    lastDoneBy: str(obj(p['last_done_by'])['name']) || null,
  };
}
