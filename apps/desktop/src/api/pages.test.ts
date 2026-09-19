import { describe, expect, it } from 'vitest';
import { processingNote } from '../screens/SpaceView';
import { workerLine } from '../components/WorkerCard';
import { blocksOf, spansOf, toPage, toProcessing, toStoredMarkdown } from './pages';
import type { WorkerStatusDto } from '../shared/ipc';

const F1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const F2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-19T12:00:00Z');

// A page as GET /v1/pages/:id returns it (server modules/pages/services/page-render.ts).
const serverPage = {
  id: 'page-1',
  project_id: 'space-1',
  slug: 'hackathon-demo-plan',
  title: 'Hackathon — demo plan',
  summary: 'The demo runs on the hosted server.',
  version: 3,
  updated_at: '2026-09-19T11:58:00.000Z',
  sections: [
    {
      id: 'sec-1',
      heading: 'Overview',
      body_md: 'The demo runs on the hosted server [^1].\n\n- Ravi runs the second Mac [^1][^2].\n- Sam sends the backup video [^2].',
      source_md: `…`,
      locked: false,
      citations: [
        { fact_id: F1, n: 1 },
        { fact_id: F2, n: 2 },
      ],
    },
    { id: 'sec-2', heading: 'Plan', body_md: 'Ana wrote this herself.', locked: true, citations: [] },
  ],
  sources: [
    { n: 1, session: { id: 'sess-1', title: 'Hackathon demo plan', source: 'claude-code', started_at: '2026-09-19T10:00:00.000Z', author: { id: 'u-ana', name: 'Ana' } }, author: { id: 'u-ana', name: 'Ana' }, facts: [{ id: F1 }] },
    { n: 2, restricted: true, session: null, author: null, facts: [] },
  ],
  session_count: 2,
};

describe('living pages from the server', () => {
  it('turns [^n] markers into citations on the text before them', () => {
    expect(spansOf('Runs on the hosted server [^1].')).toEqual([{ text: 'Runs on the hosted server', cites: [1] }, { text: '.' }]);
    expect(spansOf('Two sources [^1][^2] and one more [^3]')).toEqual([
      { text: 'Two sources', cites: [1, 2] },
      { text: ' and one more', cites: [3] },
    ]);
    expect(spansOf('No citations here.')).toEqual([{ text: 'No citations here.' }]);
  });

  it('keeps paragraphs and list items apart', () => {
    expect(blocksOf('One [^1].\n\n- Two [^2].\n- Three.').map((b) => b.kind)).toEqual(['p', 'li', 'li']);
  });

  it('maps sections, the locked flag and sources that say who said it', () => {
    const page = toPage(serverPage, NOW);
    expect(page.sections.map((s) => [s.heading, s.locked, s.blocks?.length])).toEqual([
      ['Overview', false, 3],
      ['Plan', true, 1],
    ]);
    expect(page.citations[0]).toEqual({ n: 1, sessionId: 'sess-1', source: 'claude-code', title: 'Hackathon demo plan', meta: 'Ana · claude code · today', author: 'Ana' });
    // A session the reader cannot open: no title, no author, no link.
    expect(page.citations[1]).toEqual({ n: 2, sessionId: '', source: 'note', title: 'A session you can’t open', meta: 'restricted' });
    expect(page.contributors).toEqual([{ name: 'Ana', facts: 1 }]);
  });

  it('an edit keeps its citations: each [^n] becomes the facts this section cited as n', () => {
    const [sec] = toPage(serverPage, NOW).sections;
    const edited = 'The demo runs on the hosted server, confirmed [^1]. Ravi and Sam are set [^2].';
    expect(toStoredMarkdown(edited, sec!.citationMap!)).toBe(`The demo runs on the hosted server, confirmed [^f:${F1}]. Ravi and Sam are set [^f:${F2}].`);
    expect(toStoredMarkdown('A marker the section never had [^9].', sec!.citationMap!)).toBe('A marker the section never had .');
  });
});

describe('what the space page says about sessions waiting for a Mac', () => {
  const base = { waiting: 0, running: 0, failed: 0, lastDoneAt: null, lastDoneBy: null };
  it('waiting, running, and the last one done', () => {
    expect(processingNote(toProcessing({ processing: { queued: 2, claimed: 0, failed: 0, last_done_at: null, last_done_by: null } }), NOW)).toBe(
      'Waiting for a teammate’s Mac with on-device AI · 2 sessions to add.',
    );
    expect(processingNote({ ...base, waiting: 1, running: 1 }, NOW)).toBe('Updating the pages from 1 session on a teammate’s Mac now.');
    expect(processingNote({ ...base, lastDoneAt: '2026-09-19T11:58:00Z', lastDoneBy: 'Ravi Kumar' }, NOW)).toBe('Last updated on Ravi’s Mac · 2 min ago');
    expect(processingNote(base, NOW)).toBeNull();
    expect(processingNote(toProcessing({}), NOW)).toBeNull();
  });
});

describe('Settings → Models: the worker status line', () => {
  const s: WorkerStatusDto = { enabled: true, configured: true, state: 'idle', current: null, last: null, lastError: null, nextCheckAt: null, jobsDone: 0 };
  it('says what this Mac is doing, in words', () => {
    expect(workerLine({ ...s, last: { kind: 'process_session', space: 'Hackathon team', at: '2026-09-19T11:58:00Z', ms: 1, facts: 3, sections: 1 } }, NOW)).toBe('Last updated Hackathon team · 2 min ago');
    expect(workerLine({ ...s, state: 'working', current: { space: 'Hackathon team', step: 'Reading the session' } }, NOW)).toBe('Updating Hackathon team · reading the session');
    expect(workerLine({ ...s, state: 'no-model' }, NOW)).toBe('Starts once the on-device model is downloaded.');
    expect(workerLine({ ...s, enabled: false }, NOW)).toBe('Off. Your team’s sessions are processed on other members’ Macs.');
    expect(workerLine({ ...s, state: 'error', lastError: 'chat HTTP 500' }, NOW)).toBe('Couldn’t finish the last one. It will be tried again.');
  });
});
