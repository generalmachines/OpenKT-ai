/**
 * The local brain: turns one claimed job into a result with the on-device model, following
 * Spec 02 — small agents, one decision each, and code (never the model) wherever arithmetic or a
 * rule can decide.
 *
 *   process_session:  summarise → extract (quote-gated, per chunk) → tag → lookup (server:
 *                     neighbours + candidate pages) → dedupe (arithmetic; the agent only in the
 *                     grey band) → route (+ guards) → write_section (one per touched section)
 *   refresh_brief:    brief
 *
 * Nothing here imports `electron`: the same code runs in the app and under plain Node
 * (scripts/worker-once.mjs).
 */
import { randomUUID } from 'node:crypto';
import type { AgentRun, AgentsModule, LlmClient, PipelineModule, PipelineNeighbour, PipelineTurn } from './modules';
import type {
  BriefJobInput,
  BriefResult,
  Kind,
  LookupPage,
  LookupResult,
  ResultFact,
  ResultSection,
  SessionJobInput,
  SessionResult,
} from './protocol';

export interface BrainDeps {
  agents: AgentsModule;
  pipeline: PipelineModule;
  llm: LlmClient;
  /** For the server's neighbours and candidate pages; also extends the job's lease. */
  lookup(facts: { id: string; statement: string }[]): Promise<LookupResult>;
  /** Called between steps: progress for the status line, and a place to keep the model loaded. */
  onStep?(step: string): void;
  now?: () => Date;
  uuid?: () => string;
  signal?: AbortSignal;
  /** Reported with the result; never trusted by the server. */
  model?: string;
}

/** Summaries see at most this much of a long session (the start, where the topic is set). */
const SUMMARY_INPUT_CHARS = 12_000;
const SECTION_MAX_CHARS = 1200;
/** A citation costs `[^f:` + 36 + `]` in storage; agents see short aliases instead of uuids. */
const UUID_CITATION_CHARS = 41;
const MAX_ROUTE_FACTS = 20;

type Step = { agent: string; ms: number; attempts: number; status: string; dropped: number; tokens?: number };

class Timings {
  readonly steps: Step[] = [];
  record<O>(agent: string, run: AgentRun<O>): AgentRun<O> {
    this.steps.push({ agent, ms: run.latency_ms, attempts: run.attempts, status: run.status, dropped: run.dropped, ...(run.usage ? { tokens: run.usage.total_tokens } : {}) });
    return run;
  }
  total(agent: string): number {
    return this.steps.filter((s) => s.agent === agent).reduce((n, s) => n + s.ms, 0);
  }
  summary(): Record<string, { calls: number; ms: number; noops: number }> {
    const out: Record<string, { calls: number; ms: number; noops: number }> = {};
    for (const s of this.steps) {
      const row = (out[s.agent] ??= { calls: 0, ms: 0, noops: 0 });
      row.calls += 1;
      row.ms += s.ms;
      if (s.status === 'noop') row.noops += 1;
    }
    return out;
  }
}

const agentTurn = (t: PipelineTurn) => ({ role: t.role, text: t.content });

function toPipelineTurns(turns: SessionJobInput['turns']): PipelineTurn[] {
  const roles = new Set(['user', 'assistant', 'speaker', 'note']);
  return turns.filter((t) => roles.has(t.role) && t.content.trim()).map((t) => ({ seq: t.seq, role: t.role as PipelineTurn['role'], content: t.content }));
}

/** Short ids for the model to copy (f1, p2, …) instead of 36-character uuids; mapped back after. */
class Aliases {
  private readonly toAlias = new Map<string, string>();
  private readonly toId = new Map<string, string>();
  constructor(private readonly prefix: string) {}
  alias(id: string): string {
    let a = this.toAlias.get(id);
    if (!a) {
      a = `${this.prefix}${this.toAlias.size + 1}`;
      this.toAlias.set(id, a);
      this.toId.set(a, id);
    }
    return a;
  }
  id(alias: string | null | undefined): string | null {
    return alias ? (this.toId.get(alias) ?? null) : null;
  }
  /** `[^f:<uuid>]` → `[^f:<alias>]` for every id in the text. */
  aliasCitations(md: string): string {
    return md.replace(/\[\^f:([0-9a-fA-F-]{36})\]/g, (_w, id: string) => `[^f:${this.alias(id.toLowerCase())}]`);
  }
  /** `[^f:<alias>]` → `[^f:<uuid>]`; an unknown alias is left for the server to refuse. */
  restoreCitations(md: string): string {
    return md.replace(/\[\^f:([^\]\s]+)\]/g, (whole, a: string) => {
      const id = this.toId.get(a);
      return id ? `[^f:${id}]` : whole;
    });
  }
}

/**
 * Page titles are shaped `Subject — aspect` (Spec 02 §5; guardRoutes refuses anything else). The
 * local model names topics well but rarely writes the dash, so code shapes it: "Hackathon - demo
 * plan" or "Hackathon: demo plan" → "Hackathon — demo plan"; "Hackathon demo plan" → the first word
 * is the subject, as in "Northgate — pricing" and "Auth — token refresh". One word stays as it is.
 */
export function shapeTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.includes(' — ')) return t;
  const m = /^(.{2,}?)(?:\s+[-–]\s+|:\s+)(.{2,})$/.exec(t);
  if (m) return `${m[1]!.trim()} — ${m[2]!.trim()}`;
  const space = t.indexOf(' ');
  return space > 0 ? `${t.slice(0, space)} — ${t.slice(space + 1)}` : t;
}

export async function processSession(input: SessionJobInput, deps: BrainDeps): Promise<SessionResult> {
  const { agents, pipeline, llm } = deps;
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const step = (s: string) => deps.onStep?.(s);
  const timings = new Timings();
  const started = Date.now();
  const opts = { signal: deps.signal };

  const turns = toPipelineTurns(input.turns);
  const meta = {
    date: input.session.started_at,
    title: input.session.title ?? undefined,
    source: input.session.source,
    author: input.session.author.name,
    space: input.space.name,
  };
  const empty: SessionResult = { summary: null, facts: [], sections: [], unrouted: [], stats: { skipped: 'too_short' } };
  if (!pipeline.shouldExtract(turns)) return empty;

  // ── J1 summarise ──
  step('Summarising');
  const head: PipelineTurn[] = [];
  let size = 0;
  for (const t of turns) {
    if (size + t.content.length > SUMMARY_INPUT_CHARS && head.length) break;
    head.push(t);
    size += t.content.length;
  }
  const summarised = timings.record('summarise', await agents.summarise.run({ chunk: head.map(agentTurn), session: meta }, llm, opts));
  const summary = summarised.status === 'ok' && summarised.output.title ? summarised.output : null;

  // ── J2 extract, per chunk (quote-gated inside the agent; the server gates again) ──
  const chunks = pipeline.chunkTurns(turns);
  const extracted: { statement: string; quote: string; kind: Kind; role: string }[] = [];
  for (const [i, chunk] of chunks.entries()) {
    step(chunks.length > 1 ? `Reading part ${i + 1} of ${chunks.length}` : 'Reading the session');
    const run = timings.record('extract', await agents.extract.run({ chunk: chunk.turns.map(agentTurn), overlap: chunk.overlap.map(agentTurn), session: meta }, llm, opts));
    for (const f of run.output.facts) {
      const turn = chunk.turns.find((t) => t.content.replace(/\s+/g, ' ').includes(f.quote.replace(/\s+/g, ' ')));
      extracted.push({ ...f, role: turn?.role ?? 'user' });
    }
  }
  const capped = pipeline.capFacts(extracted, pipeline.MAX_FACTS_PER_SESSION);

  // ── J4a tag: the space's vocabulary first; new tags join it for the next fact ──
  const vocabulary = input.vocabulary.map((v) => ({ ...v }));
  const facts: (ResultFact & { role: string })[] = [];
  for (const [i, f] of capped.entries()) {
    step(`Tagging ${i + 1} of ${capped.length}`);
    const run = timings.record('tag', await agents.tag.run({ fact: { statement: f.statement, kind: f.kind }, vocabulary }, llm, opts));
    const { tags } = pipeline.normaliseTags(run.output.tags, vocabulary, (a, b) => (a === b ? 1 : 0));
    for (const t of tags) {
      const known = vocabulary.find((v) => v.tag === t);
      if (known) known.count += 1;
      else vocabulary.push({ tag: t, count: 1 });
    }
    facts.push({ id: uuid(), statement: f.statement, quote: f.quote, kind: f.kind, tags, duplicate_of: null, supersedes: [], role: f.role });
  }

  // ── lookup: the server's nearest facts (its own embeddings) and candidate pages ──
  step('Looking at the space');
  const lookup = await deps.lookup(facts.map((f) => ({ id: f.id, statement: f.statement })));

  // ── J4b dedupe: arithmetic first (Spec 02 §3); the agent only between 0.82 and 0.97 ──
  const createdAt = now().toISOString();
  for (const f of facts) {
    const neighbours: PipelineNeighbour[] = lookup.neighbours[f.id] ?? [];
    const decision = pipeline.decideDuplicate(neighbours);
    if (decision.action === 'duplicate') {
      f.duplicate_of = decision.of;
    } else if (decision.action === 'ask_agent') {
      step('Checking for repeats');
      const aliases = new Aliases('n');
      const run = timings.record(
        'dedupe',
        await agents.dedupe.run(
          { fact: { statement: f.statement, created_at: createdAt }, neighbours: decision.candidates.map((n) => ({ id: aliases.alias(n.id), statement: n.statement, created_at: n.created_at })) },
          llm,
          opts,
        ),
      );
      const answer = { duplicate_of: aliases.id(run.output.duplicate_of), supersedes: run.output.supersedes.map((a) => aliases.id(a)).filter((id): id is string => Boolean(id)) };
      const guarded = pipeline.guardSupersede(
        { kind: f.kind, created_at: createdAt, project_id: input.space.id, owner_user_id: input.session.author.id },
        answer,
        decision.candidates,
      );
      f.duplicate_of = guarded.duplicate_of;
      f.supersedes = guarded.supersedes;
    }
  }

  // ── J5 route: new facts and the facts saved during the session; never personal ones (the server only sends those it may) ──
  const confidenceOf = (role: string) => (role === 'user' ? 0.75 : role === 'assistant' ? 0.55 : 0.5);
  const routable = [
    ...facts.filter((f) => !f.duplicate_of).map((f) => ({ id: f.id, statement: f.statement, kind: f.kind, confidence: confidenceOf(f.role), author: input.session.author.name, date: createdAt })),
    ...input.session_facts.map((f) => ({ id: f.id, statement: f.statement, kind: f.kind, confidence: 0.9, author: f.author, date: f.created_at })),
    // Facts earlier sessions left unrouted: a topic gets its page once enough has been said about it.
    ...(input.unrouted_facts ?? [])
      .filter((f) => !input.session_facts.some((s) => s.id === f.id))
      .map((f) => ({ id: f.id, statement: f.statement, kind: f.kind, confidence: 0.75, author: f.author, date: f.created_at })),
  ];
  const ageDays = (iso: string) => Math.max(0, (now().getTime() - Date.parse(iso)) / 86_400_000) || 0;
  const pages: LookupPage[] = lookup.pages.slice(0, 8);
  const routes: { fact_id: string; action: 'append' | 'rewrite_section' | 'new_page'; page_id?: string; section_title?: string; new_page_title?: string }[] = [];
  const unrouted: { id: string; reason: string }[] = [];
  for (let i = 0; i < routable.length; i += MAX_ROUTE_FACTS) {
    const batch = routable.slice(i, i + MAX_ROUTE_FACTS);
    step('Choosing pages');
    const fa = new Aliases('f');
    const pa = new Aliases('p');
    const run = timings.record(
      'route',
      await agents.route.run(
        {
          facts: batch.map((f) => ({ id: fa.alias(f.id), statement: f.statement, kind: f.kind })),
          pages: pages.map((p) => ({ id: pa.alias(p.id), title: p.title, summary: p.summary, section_titles: p.sections.map((s) => s.heading) })),
        },
        llm,
        opts,
      ),
    );
    const proposals = run.output.decisions.map((d) => ({
      fact_id: fa.id(d.fact_id) ?? d.fact_id,
      action: d.action,
      page_id: pa.id(d.page_id),
      section_title: d.section_title,
      new_page_title: d.new_page_title ? shapeTitle(d.new_page_title) : null,
    }));
    const guarded = pipeline.guardRoutes({
      facts: batch.map((f) => ({
        id: f.id,
        project_id: input.space.id,
        statement: f.statement,
        kind: f.kind,
        created_at: f.date,
        owner_user_id: input.session.author.id,
        is_pinned: false,
        confidence: f.confidence,
        age_days: ageDays(f.date),
      })),
      proposals,
      pages: pages.map((p) => ({ id: p.id, sections: p.sections.map((s) => ({ heading: s.heading, locked: s.locked })) })),
      unroutedTitles: [],
      titleSimilarity: (a, b) => (a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0),
    });
    routes.push(...guarded.routes);
    unrouted.push(...guarded.unrouted.map((u) => ({ id: u.fact_id, reason: u.reason })));
  }

  // ── J6 write_section: one call per (page, section) ──
  const groups = new Map<string, { page: LookupPage | null; newTitle: string | null; heading: string; mode: 'append' | 'rewrite_section'; factIds: string[] }>();
  for (const r of routes) {
    const page = r.page_id ? (pages.find((p) => p.id === r.page_id) ?? null) : null;
    const heading = (r.section_title?.trim() || (page ? 'Updates' : 'Overview')).slice(0, 120);
    const key = `${page?.id ?? `new:${r.new_page_title?.toLowerCase()}`}::${heading.toLowerCase()}`;
    const group = groups.get(key) ?? { page, newTitle: page ? null : (r.new_page_title ?? null), heading, mode: 'append' as const, factIds: [] };
    if (r.action === 'rewrite_section') group.mode = 'rewrite_section';
    group.factIds.push(r.fact_id);
    groups.set(key, group);
  }
  const byId = new Map(routable.map((f) => [f.id, f]));
  const supersededBy = new Map<string, string[]>(facts.map((f) => [f.id, f.supersedes]));
  const sections: ResultSection[] = [];
  let n = 0;
  for (const group of groups.values()) {
    n += 1;
    step(`Writing ${n} of ${groups.size}`);
    const existing = group.page?.sections.find((s) => s.heading.trim().toLowerCase() === group.heading.toLowerCase()) ?? null;
    if (existing?.locked) continue; // guardRoutes redirects these; never write a person's section
    const aliases = new Aliases('f');
    const groupFacts = group.factIds.map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    const agentFacts = groupFacts.map((f) => ({ id: aliases.alias(f.id), statement: f.statement, author: f.author, date: f.date.slice(0, 10) }));
    const current = existing ? aliases.aliasCitations(existing.body_md) : '';
    const cited = new Set(existing?.fact_ids ?? []);
    const superseded = group.factIds.flatMap((id) => supersededBy.get(id) ?? []).filter((id) => cited.has(id)).map((id) => aliases.alias(id));
    const citations = new Set([...(existing?.fact_ids ?? []), ...group.factIds]).size;
    const run = timings.record(
      'write_section',
      await agents.writeSection.run(
        {
          page_title: group.page?.title ?? group.newTitle ?? group.heading,
          section_title: group.heading,
          section_md: current,
          mode: existing ? group.mode : 'append',
          facts: agentFacts,
          superseded_ids: superseded,
          // Leave room for the aliases to become uuids again.
          max_chars: Math.max(400, SECTION_MAX_CHARS - citations * (UUID_CITATION_CHARS - 5)),
        },
        llm,
        opts,
      ),
    );
    sections.push({
      page_id: group.page?.id ?? null,
      new_page_title: group.page ? null : group.newTitle,
      section_id: existing?.id ?? null,
      heading: group.heading,
      body_md: aliases.restoreCitations(run.output.section_md),
      mode: run.status === 'noop' ? 'fallback' : existing ? group.mode : 'append',
    });
  }

  return {
    summary,
    facts: facts.map(({ role: _role, ...f }) => f),
    sections,
    unrouted,
    stats: {
      model: deps.model ?? 'local',
      runtime: 'llama.cpp',
      total_ms: Date.now() - started,
      chunks: chunks.length,
      extracted: extracted.length,
      agents: timings.summary(),
      steps: timings.steps,
      embedding: lookup.embedding,
    },
  };
}

/** The prompt says to leave out a part with nothing in it; a small model writes "- None" instead. */
export function withoutEmptyParts(md: string): string {
  const parts = md.split(/\n(?=##\s)/);
  const kept = parts.filter((part) => {
    const bullets = part.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    return !bullets.length || !bullets.every((b) => /^[-*]\s*(none|nothing|n\/a)\.?$/i.test(b));
  });
  return kept.join('\n').trim();
}

export async function refreshBrief(input: BriefJobInput, deps: Pick<BrainDeps, 'agents' | 'llm' | 'onStep' | 'signal' | 'model'>): Promise<BriefResult> {
  deps.onStep?.('Writing the brief');
  const started = Date.now();
  const run = await deps.agents.brief.run(
    { space: input.space.name, pages: input.pages, recent_changes: input.recent_changes, max_chars: input.max_chars },
    deps.llm,
    { signal: deps.signal },
  );
  return {
    // The brief agent's no-op is "" — the server then keeps the previous brief.
    brief_md: run.status === 'ok' ? withoutEmptyParts(run.output.brief_md) : '',
    source_hash: input.source_hash,
    stats: { model: deps.model ?? 'local', runtime: 'llama.cpp', total_ms: Date.now() - started, brief: { ms: run.latency_ms, attempts: run.attempts, status: run.status } },
  };
}
