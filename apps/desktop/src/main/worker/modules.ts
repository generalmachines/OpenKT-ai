/**
 * The slices of @openkt/agents and @openkt/pipeline the worker uses, declared here so typechecking
 * this app does not need those packages built (their dist/ is not committed). Both are ESM; this
 * process is CommonJS. The packaged app ships esbuild bundles (dist-electron/vendor/*.cjs, built by
 * scripts/bundle-agents.mjs); dev and tests fall back to the workspace packages.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Kind } from './protocol';

export interface AgentRun<O> {
  output: O;
  status: 'ok' | 'noop';
  attempts: number;
  dropped: number;
  notes: string[];
  errors: string[];
  latency_ms: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface LlmClient {
  complete(request: unknown): Promise<{ text: string }>;
}

type AgentTurn = { role: string; speaker?: string; text: string };
type SessionMeta = { date?: string; title?: string; source?: string; author?: string; participants?: string[]; space?: string };
type Agent<I, O> = { run(input: I, client: LlmClient, options?: { signal?: AbortSignal }): Promise<AgentRun<O>> };

export interface AgentsModule {
  OpenAiCompatibleClient: new (config: { baseUrl: string; model?: string; timeoutMs?: number; apiKey?: string }) => LlmClient;
  summarise: Agent<{ chunk: AgentTurn[] | string; session: SessionMeta }, { title: string; summary: string; open_questions: string[] }>;
  extract: Agent<{ chunk: AgentTurn[] | string; session: SessionMeta; overlap?: AgentTurn[] | string }, { facts: { statement: string; quote: string; kind: Kind }[] }>;
  tag: Agent<{ fact: { statement: string; kind: Kind }; vocabulary: { tag: string; count: number }[] }, { tags: string[] }>;
  dedupe: Agent<{ fact: { statement: string; created_at?: string }; neighbours: { id: string; statement: string; created_at: string }[] }, { duplicate_of: string | null; supersedes: string[] }>;
  route: Agent<
    { facts: { id: string; statement: string; kind: Kind }[]; pages: { id: string; title: string; summary: string; section_titles: string[] }[] },
    { decisions: { fact_id: string; action: 'append' | 'rewrite_section' | 'new_page' | 'noop'; page_id: string | null; section_title: string | null; new_page_title: string | null }[] }
  >;
  writeSection: Agent<
    {
      page_title: string;
      section_title: string;
      section_md: string;
      mode?: 'append' | 'rewrite_section';
      facts: { id: string; statement: string; author: string; date: string }[];
      superseded_ids: string[];
      max_chars?: number;
    },
    { section_md: string }
  >;
  brief: Agent<
    { space: string; pages: { title: string; summary: string; updated_at?: string }[]; recent_changes: { date: string; page_title: string; change: string }[]; max_chars?: number },
    { brief_md: string }
  >;
}

export interface PipelineTurn {
  seq: number;
  role: 'user' | 'assistant' | 'speaker' | 'system' | 'note';
  speaker?: string;
  content: string;
  part?: number;
}

export interface PipelineNeighbour {
  id: string;
  project_id: string;
  statement: string;
  kind: Kind;
  created_at: string;
  owner_user_id: string;
  is_pinned: boolean;
  confidence: number;
  similarity: number;
}

export interface PipelineModule {
  shouldExtract(turns: PipelineTurn[]): boolean;
  chunkTurns(turns: PipelineTurn[], opts?: { maxChars?: number; overlapTurns?: number }): { index: number; turns: PipelineTurn[]; overlap: PipelineTurn[] }[];
  capFacts<T extends { kind: Kind }>(facts: T[], max: number): T[];
  MAX_FACTS_PER_SESSION: number;
  decideDuplicate(neighbours: PipelineNeighbour[]): { action: 'duplicate'; of: string } | { action: 'ask_agent'; candidates: PipelineNeighbour[] } | { action: 'new' };
  guardSupersede(
    newFact: { kind: Kind; created_at: string; project_id: string; owner_user_id: string },
    answer: { duplicate_of: string | null; supersedes: string[] },
    candidates: PipelineNeighbour[],
  ): { duplicate_of: string | null; supersedes: string[]; rejected: { id: string; reason: string }[] };
  normaliseTags(proposed: string[], vocab: { tag: string; count: number }[], similarity: (a: string, b: string) => number): { tags: string[]; created: string[] };
  guardRoutes(input: {
    facts: (PipelineNeighbourLike & { age_days: number })[];
    proposals: { fact_id: string; action: 'append' | 'rewrite_section' | 'new_page' | 'noop'; page_id?: string | null; section_title?: string | null; new_page_title?: string | null }[];
    pages: { id: string; sections: { heading: string; locked: boolean }[] }[];
    unroutedTitles: string[];
    titleSimilarity: (a: string, b: string) => number;
  }): {
    routes: { fact_id: string; action: 'append' | 'rewrite_section' | 'new_page'; page_id?: string; section_title?: string; new_page_title?: string; redirected_from_locked?: boolean }[];
    unrouted: { fact_id: string; reason: string }[];
  };
}

type PipelineNeighbourLike = Omit<PipelineNeighbour, 'similarity'>;

const load = <T>(bundle: string, pkg: string): Promise<T> => {
  const bundled = join(__dirname, '..', '..', 'vendor', bundle);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return existsSync(bundled) ? Promise.resolve(require(bundled) as T) : (import(pkg) as Promise<T>);
};

let agents: Promise<AgentsModule> | null = null;
let pipeline: Promise<PipelineModule> | null = null;

const AGENTS_PACKAGE: string = '@openkt/agents';
const PIPELINE_PACKAGE: string = '@openkt/pipeline';

export function loadAgentsModule(): Promise<AgentsModule> {
  agents ??= load<AgentsModule>('openkt-agents.cjs', AGENTS_PACKAGE);
  return agents;
}

export function loadPipelineModule(): Promise<PipelineModule> {
  pipeline ??= load<PipelineModule>('openkt-pipeline.cjs', PIPELINE_PACKAGE);
  return pipeline;
}
