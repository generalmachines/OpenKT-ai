/**
 * Runs @openkt/agents against the local chat server from the main process.
 * @openkt/agents is ESM and this process is CommonJS, so it is loaded lazily:
 * the packaged app ships an esbuild bundle (dist-electron/vendor/openkt-agents.cjs,
 * built by scripts/bundle-agents.mjs); dev and tests fall back to the workspace package.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LlamaLocalAi } from './local-ai';

/**
 * The slice of @openkt/agents used here, declared locally so that typechecking this app does
 * not require packages/agents to be built first (its dist/ is not committed).
 */
interface AgentRun<O> { output: O; status: 'ok' | 'noop'; attempts: number; dropped: number; notes: string[]; errors: string[]; latency_ms: number; usage?: unknown }
interface SessionMeta { date?: string; title?: string; source?: string; author?: string; participants?: string[]; space?: string }
interface AgentInput { chunk: string | { role: string; speaker?: string; text: string }[]; session: SessionMeta }
interface LlmClient { complete(request: unknown): Promise<{ text: string }> }
export interface AgentsModule {
  OpenAiCompatibleClient: new (config: { baseUrl: string; model?: string; timeoutMs?: number }) => LlmClient;
  summarise: { run(input: AgentInput, client: LlmClient): Promise<AgentRun<{ title: string; summary: string; open_questions: string[] }>> };
  extract: { run(input: AgentInput, client: LlmClient): Promise<AgentRun<{ facts: { kind?: string; statement: string; quote: string }[] }>> };
  quoteGate<F extends { quote: string }>(facts: F[], sessionText: string): { kept: F[]; dropped: F[] };
}

const AGENTS_PACKAGE: string = '@openkt/agents';
const importAgents = () => import(AGENTS_PACKAGE) as Promise<AgentsModule>;

let cached: Promise<AgentsModule> | null = null;
export function loadAgents(): Promise<AgentsModule> {
  if (!cached) {
    const bundled = join(__dirname, '..', '..', 'vendor', 'openkt-agents.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = existsSync(bundled) ? Promise.resolve(require(bundled) as AgentsModule) : importAgents();
  }
  return cached;
}

export interface NoteFact { kind: string; statement: string; quote: string }
export interface ExtractedNote {
  title: string;
  summary: string;
  facts: NoteFact[];
  /** "ok" only when both agents returned validated model output. */
  status: 'ok' | 'partial' | 'noop';
  latencyMs: { summarise: number; extract: number };
  notes: string[];
}

export interface NoteInput { text: string; title?: string; date?: string; source?: string; author?: string }

export async function extractNote(ai: LlamaLocalAi, input: NoteInput, timeoutMs = 120_000): Promise<ExtractedNote> {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (!text.trim()) return { title: '', summary: '', facts: [], status: 'noop', latencyMs: { summarise: 0, extract: 0 }, notes: ['empty text'] };
  const agents = await loadAgents();
  const run = async () => {
    const client = new agents.OpenAiCompatibleClient({ baseUrl: await ai.chatBaseUrl(), model: 'local', timeoutMs });
    // Sequential on purpose: the chat server runs one slot.
    const s = await agents.summarise.run({ chunk: text, session }, client);
    ai.chatServer.touch();
    const x = await agents.extract.run({ chunk: text, session }, client);
    ai.chatServer.touch();
    return { s, x };
  };
  const session = {
    date: input.date ?? new Date().toISOString().slice(0, 10),
    title: input.title ?? '',
    source: input.source ?? 'note',
    author: input.author ?? '',
  };
  let { s, x } = await run();
  // Agents swallow transport errors into a no-op; if the cause was a GPU crash, retry once on the CPU.
  if ((s.status === 'noop' || x.status === 'noop') && (await new Promise((r) => setTimeout(r, 400)), await ai.fallBackToCpuIfCrashed())) ({ s, x } = await run());
  const ok = [s.status, x.status].filter((v) => v === 'ok').length;
  return {
    title: s.output.title,
    summary: s.output.summary,
    facts: x.output.facts.map((f) => ({ kind: f.kind ?? 'fact', statement: f.statement, quote: f.quote })),
    status: ok === 2 ? 'ok' : ok === 1 ? 'partial' : 'noop',
    latencyMs: { summarise: Math.round(s.latency_ms), extract: Math.round(x.latency_ms) },
    notes: [...s.notes, ...s.errors, ...x.notes, ...x.errors],
  };
}
