// @vitest-environment node
/**
 * The on-device worker: the brain's steps against a scripted model (the real @openkt/agents
 * validation and the real @openkt/pipeline rules run; only the model replies are canned), and the
 * loop's claim → run → complete / fail behaviour against a fake server.
 */
import { describe, expect, it, vi } from 'vitest';
// From source, like pipeline: the CI runs these tests before it builds the packages.
import * as agents from '../../../../packages/agents/src/index';
import * as pipeline from '../../../../packages/pipeline/src/index';
import { processSession, refreshBrief, shapeTitle, withoutEmptyParts } from '../../src/main/worker/brain';
import type { AgentsModule, LlmClient, PipelineModule } from '../../src/main/worker/modules';
import type { Claim, JobsServer, LookupResult, SessionJobInput, SessionResult } from '../../src/main/worker/protocol';
import { ServerError } from '../../src/main/worker/protocol';
import { LocalWorker } from '../../src/main/worker/worker';

const SPACE = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const LOCKED = '44444444-4444-4444-8444-444444444444';
const OLD_FACT = '55555555-5555-4555-8555-555555555555';

const TURNS = [
  { seq: 1, role: 'user', content: 'We decided the hackathon demo runs on the hosted server, because the venue Wi-Fi blocks laptop ports.' },
  { seq: 2, role: 'assistant', content: 'Noted. Ravi runs the second Mac so the audience sees the page update on his screen.' },
  { seq: 3, role: 'user', content: 'Sam sends the backup video to the group by Friday 6pm in case the network fails.' },
];

function input(over: Partial<SessionJobInput> = {}): SessionJobInput {
  return {
    space: { id: SPACE, name: 'Hackathon team' },
    session: { id: 'sess-1', title: null, summary: null, source: 'claude-code', started_at: '2026-09-19T10:00:00Z', ended_at: null, author: { id: ANA, name: 'Ana' } },
    turns: TURNS,
    vocabulary: [{ tag: 'demo', count: 3 }],
    session_facts: [],
    limits: { section_max_chars: 1200, page_max_sections: 8, brief_max_chars: 1500 },
    ...over,
  };
}

/** Answers by the schema name each agent sends; `route` and `write_section` see the aliases the brain uses. */
function scriptedModel(replies: Partial<Record<string, (messages: { content: unknown }[]) => unknown>>): LlmClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async complete(request: unknown) {
      const r = request as { schema: { name: string }; messages: { content: unknown }[] };
      calls.push(r.schema.name);
      const reply = replies[r.schema.name];
      if (!reply) throw new Error(`no scripted reply for ${r.schema.name}`);
      return { text: JSON.stringify(reply(r.messages)) };
    },
  };
}

const facts = [
  { statement: 'The hackathon demo runs on the hosted server because the venue Wi-Fi blocks laptop ports.', quote: 'We decided the hackathon demo runs on the hosted server', kind: 'decision' },
  { statement: 'Ravi runs the second Mac during the demo.', quote: 'Ravi runs the second Mac', kind: 'fact' },
  { statement: 'Sam sends the backup video by Friday 6pm.', quote: 'Sam sends the backup video to the group by Friday 6pm', kind: 'action' },
  { statement: 'The demo is streamed live.', quote: 'we stream the whole demo live', kind: 'fact' }, // not in the session: the quote gate drops it
];

const userText = (messages: { content: unknown }[]) => String(messages[1]?.content ?? '');

function baseReplies(route: (m: { content: unknown }[]) => unknown, write: (m: { content: unknown }[]) => unknown) {
  return {
    summarise: () => ({ title: 'Hackathon demo plan', summary: 'Ana settled where the demo runs and who does what.', open_questions: [] }),
    extract: () => ({ facts }),
    tag: () => ({ tags: ['Demo'] }),
    route,
    write_section: write,
  };
}

const deps = (llm: LlmClient, lookup: LookupResult, extra: Partial<Parameters<typeof processSession>[1]> = {}) => {
  let n = 0;
  return {
    agents: agents as unknown as AgentsModule,
    pipeline: pipeline as unknown as PipelineModule,
    llm,
    lookup: vi.fn(async () => lookup),
    uuid: () => `aaaaaaaa-0000-4000-8000-00000000000${++n}`,
    now: () => new Date('2026-09-19T12:00:00Z'),
    ...extra,
  };
};

const emptyLookup = (ids: string[] = []): LookupResult => ({ lease_until: '', embedding: 'ok', neighbours: Object.fromEntries(ids.map((id) => [id, []])), pages: [] });

describe('the local brain (process_session)', () => {
  it('extracts quote-gated facts, tags them, and writes one new page citing them — ids the model never had to copy', async () => {
    const llm = scriptedModel(
      baseReplies(
        (m) => {
          const f = JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string }[];
          return { decisions: f.map((x) => ({ fact_id: x.id, action: 'new_page', page_id: null, section_title: null, new_page_title: 'Hackathon demo plan' })) };
        },
        (m) => {
          const f = JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string; statement: string }[];
          return { section_md: f.map((x) => `- ${x.statement} [^f:${x.id}]`).join('\n') };
        },
      ),
    );
    const d = deps(llm, emptyLookup());
    const result: SessionResult = await processSession(input(), d);

    expect(result.summary?.title).toBe('Hackathon demo plan');
    expect(result.facts.map((f) => f.kind)).toEqual(['decision', 'fact', 'action']); // the fourth had no quote in the session
    expect(result.facts.map((f) => f.id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003']);
    expect(result.facts[0]!.tags).toEqual(['demo']);
    expect(d.lookup).toHaveBeenCalledWith(result.facts.map((f) => ({ id: f.id, statement: f.statement })));
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({ page_id: null, new_page_title: 'Hackathon — demo plan', heading: 'Overview', mode: 'append' });
    for (const f of result.facts) expect(result.sections[0]!.body_md).toContain(`[^f:${f.id}]`);
    expect(result.sections[0]!.body_md).not.toMatch(/\[\^f:f\d+\]/); // aliases never reach the server
    expect(llm.calls).toEqual(['summarise', 'extract', 'tag', 'tag', 'tag', 'route', 'write_section']);
  });

  it('facts earlier sessions left unrouted join this one, so a topic reaches the three facts a new page needs', async () => {
    const older = [
      { id: 'bbbbbbbb-0000-4000-8000-000000000001', statement: 'The judges score live usefulness.', kind: 'fact' as const, author: 'Sam', created_at: '2026-09-18T09:00:00Z' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', statement: 'The demo slot is five minutes.', kind: 'fact' as const, author: 'Ravi', created_at: '2026-09-18T10:00:00Z' },
    ];
    const llm = scriptedModel({
      ...baseReplies(
        (m) => {
          const f = JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string }[];
          return { decisions: f.map((x) => ({ fact_id: x.id, action: 'new_page', page_id: null, section_title: null, new_page_title: 'Hackathon judging' })) };
        },
        (m) => {
          const f = JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string; statement: string; author: string }[];
          return { section_md: f.map((x) => `- ${x.statement} [^f:${x.id}]`).join('\n') };
        },
      ),
      extract: () => ({ facts: [{ statement: 'Ravi runs the second Mac during the demo.', quote: 'Ravi runs the second Mac', kind: 'fact' }] }),
    });
    const result = await processSession(input({ unrouted_facts: older }), deps(llm, emptyLookup()));
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.new_page_title).toBe('Hackathon — judging');
    for (const id of [...older.map((f) => f.id), result.facts[0]!.id]) expect(result.sections[0]!.body_md).toContain(`[^f:${id}]`);
    // Alone, the one fact of this session would have waited for more.
    const alone = await processSession(input(), deps(scriptedModel({ ...baseReplies((m) => ({ decisions: (JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string }[]).map((x) => ({ fact_id: x.id, action: 'new_page', page_id: null, section_title: null, new_page_title: 'Hackathon judging' })) }), () => ({ section_md: '' })), extract: () => ({ facts: [{ statement: 'Ravi runs the second Mac during the demo.', quote: 'Ravi runs the second Mac', kind: 'fact' }] }) }), emptyLookup()));
    expect(alone.sections).toEqual([]);
    expect(alone.unrouted).toEqual([{ id: alone.facts[0]!.id, reason: 'waiting_for_more' }]);
  });

  it('never writes a locked section: a fact meant for it goes to Updates', async () => {
    const lookup: LookupResult = {
      lease_until: '',
      embedding: 'ok',
      neighbours: {},
      pages: [{ id: PAGE, title: 'Hackathon — demo plan', summary: '', score: 1, sections: [{ id: LOCKED, heading: 'Plan', body_md: 'Ana wrote this.', locked: true, fact_ids: [] }] }],
    };
    const llm = scriptedModel(
      baseReplies(
        (m) => {
          const f = JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string }[];
          return { decisions: f.map((x) => ({ fact_id: x.id, action: 'rewrite_section', page_id: 'p1', section_title: 'Plan', new_page_title: null })) };
        },
        (m) => {
          const f = JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string; statement: string }[];
          return { section_md: f.map((x) => `- ${x.statement} [^f:${x.id}]`).join('\n') };
        },
      ),
    );
    const result = await processSession(input(), deps(llm, lookup));
    expect(result.sections.map((s) => [s.page_id, s.section_id, s.heading])).toEqual([[PAGE, null, 'Updates']]);
  });

  it('asks the dedupe agent only between 0.82 and 0.97; at 0.97 it is a duplicate without a model call', async () => {
    const neighbour = (similarity: number) => ({ id: OLD_FACT, project_id: SPACE, statement: 'The demo runs on the hosted server.', kind: 'decision' as const, created_at: '2026-09-01T00:00:00Z', owner_user_id: ANA, is_pinned: false, confidence: 0.75, similarity });
    for (const [sim, calls, dup] of [
      [0.97, 0, OLD_FACT],
      [0.9, 1, null],
      [0.81, 0, null],
    ] as const) {
      const llm = scriptedModel({
        ...baseReplies(
          (m) => ({ decisions: (JSON.parse(userText(m).split('<facts>')[1]!.split('</facts>')[0]!) as { id: string }[]).map((x) => ({ fact_id: x.id, action: 'noop', page_id: null, section_title: null, new_page_title: null })) }),
          () => ({ section_md: '' }),
        ),
        extract: () => ({ facts: [facts[0]] }),
        dedupe: () => ({ duplicate_of: null, supersedes: ['n1'] }),
      });
      const lookup: LookupResult = { lease_until: '', embedding: 'ok', neighbours: { 'aaaaaaaa-0000-4000-8000-000000000001': [neighbour(sim)] }, pages: [] };
      const result = await processSession(input(), deps(llm, lookup));
      expect(llm.calls.filter((c) => c === 'dedupe')).toHaveLength(calls);
      expect(result.facts[0]!.duplicate_of).toBe(dup);
      if (sim === 0.9) expect(result.facts[0]!.supersedes).toEqual([OLD_FACT]); // n1 mapped back to the real id
    }
  });

  it('a session with under 200 characters of text is not processed at all', async () => {
    const llm = scriptedModel({});
    const result = await processSession(input({ turns: [{ seq: 1, role: 'user', content: 'ok, thanks' }] }), deps(llm, emptyLookup()));
    expect(result).toMatchObject({ summary: null, facts: [], sections: [] });
    expect(llm.calls).toEqual([]);
  });

  it('the brief: the agent’s answer, or "" (keep the old one) when it fails', async () => {
    const briefInput = { space: { id: SPACE, name: 'Hackathon team' }, pages: [{ title: 'Hackathon — demo plan', summary: 'Runs on the hosted server.', updated_at: '2026-09-19' }], recent_changes: [], previous_brief: null, source_hash: 'h1', max_chars: 1500 };
    const ok = await refreshBrief(briefInput, { agents: agents as unknown as AgentsModule, llm: scriptedModel({ brief: () => ({ brief_md: '## What matters now\n- Hosted server (Hackathon — demo plan)' }) }) });
    expect(ok).toMatchObject({ brief_md: '## What matters now\n- Hosted server (Hackathon — demo plan)', source_hash: 'h1' });
    const bad = await refreshBrief(briefInput, { agents: agents as unknown as AgentsModule, llm: scriptedModel({ brief: () => ({ nope: true }) }) });
    expect(bad.brief_md).toBe('');
  });

  it('drops a brief part that says only "None"', () => {
    expect(withoutEmptyParts('## What matters now\n- A (P)\n\n## Open\n- None')).toBe('## What matters now\n- A (P)');
    expect(withoutEmptyParts('## Open\n- None of the stores export CSV yet (P)')).toBe('## Open\n- None of the stores export CSV yet (P)');
  });

  it('shapes page titles as "Subject — aspect"', () => {
    expect(shapeTitle('Hackathon demo plan')).toBe('Hackathon — demo plan');
    expect(shapeTitle('Hackathon - demo plan')).toBe('Hackathon — demo plan');
    expect(shapeTitle('Northgate: pricing')).toBe('Northgate — pricing');
    expect(shapeTitle('Auth — token refresh')).toBe('Auth — token refresh');
    expect(shapeTitle('Pricing')).toBe('Pricing');
  });
});

describe('the worker loop', () => {
  const server = (claim: Claim): JobsServer & { completed: unknown[]; failed: unknown[] } => {
    const completed: unknown[] = [];
    const failed: unknown[] = [];
    let given = false;
    return {
      completed,
      failed,
      claim: vi.fn(async () => (given ? { job: null } : ((given = true), claim))),
      lookup: vi.fn(async () => emptyLookup()),
      complete: vi.fn(async (_id: string, r: unknown) => (completed.push(r), { applied: { facts: { saved: 2, duplicates: 0, superseded: 0, dropped: {} }, sections: { written: 1, fallback: 0, refused: {} } } })),
      fail: vi.fn(async (id: string, error: string, retry: boolean) => void failed.push({ id, error, retry })),
    };
  };
  const make = (s: JobsServer, ready = { signedIn: true, modelReady: true }, brief = () => ({ brief_md: '## What matters now\n- x (y)' })) =>
    new LocalWorker({
      server: s,
      model: 'Qwen3.5-4B',
      workerName: () => 'test-mac · Qwen3.5-4B',
      modules: async () => ({ agents: agents as unknown as AgentsModule, pipeline: pipeline as unknown as PipelineModule }),
      llm: async () => scriptedModel({ brief }),
      readiness: async () => ready,
    });
  const briefClaim: Claim = {
    job: { id: 'job-1', kind: 'refresh_brief', project_id: SPACE, session_id: null, attempts: 1, lease_until: '' },
    input: { space: { id: SPACE, name: 'Hackathon team' }, pages: [{ title: 'T — a', summary: 's', updated_at: '' }], recent_changes: [], previous_brief: null, source_hash: 'h', max_chars: 1500 },
  };

  it('signed out, or no model on this Mac: it does not ask the server for work', async () => {
    for (const ready of [{ signedIn: false, modelReady: true }, { signedIn: true, modelReady: false }]) {
      const s = server(briefClaim);
      const w = make(s, ready);
      expect(await w.tick()).toBe(false);
      expect(s.claim).not.toHaveBeenCalled();
      expect(w.status().state).toBe(ready.signedIn ? 'no-model' : 'signed-out');
    }
  });

  it('claims a job, runs it and posts the result; then reports what it did', async () => {
    const s = server(briefClaim);
    const w = make(s);
    expect(await w.tick()).toBe(true);
    expect(s.completed).toEqual([expect.objectContaining({ brief_md: '## What matters now\n- x (y)', source_hash: 'h' })]);
    expect(w.status()).toMatchObject({ state: 'idle', jobsDone: 1, last: { kind: 'refresh_brief', space: 'Hackathon team' } });
    expect(await w.tick()).toBe(false); // nothing more to do
  });

  it('a job that throws is given back to the server to retry later', async () => {
    const s = server(briefClaim);
    s.complete = vi.fn(async () => {
      throw new Error('chat HTTP 500');
    });
    const w = make(s);
    expect(await w.tick()).toBe(true);
    expect(s.failed).toEqual([{ id: 'job-1', error: 'chat HTTP 500', retry: true }]);
    expect(w.status().state).toBe('error');
  });

  it('a lost lease (409) is not retried from here', async () => {
    const s = server(briefClaim);
    s.complete = vi.fn(async () => {
      throw new ServerError('This job is no longer yours to complete.', 409, 'lease_lost');
    });
    await make(s).tick();
    expect(s.failed).toEqual([{ id: 'job-1', error: 'This job is no longer yours to complete.', retry: false }]);
  });

  it('switched off, it does nothing', async () => {
    const s = server(briefClaim);
    const w = make(s);
    w.setEnabled(false);
    expect(await w.tick()).toBe(false);
    expect(s.claim).not.toHaveBeenCalled();
    expect(w.status()).toMatchObject({ enabled: false, state: 'off' });
  });
});
