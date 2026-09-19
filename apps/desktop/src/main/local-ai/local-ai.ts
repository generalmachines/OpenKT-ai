/**
 * LocalAi: the provider seam for on-device inference. Today it is llama.cpp's
 * `llama-server` bundled in the app; the Swift/MLX engine replaces the
 * implementation, not the interface. Nothing here imports `electron`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ModelStore, type ModelsProgress, type ModelStatus } from '../models/store';
import type { ModelPlan, ModelRole } from '../models/manifest';
import { LlamaServer, type ServerState } from './supervisor';

export const QUERY_PREFIX = 'Instruct: Given a question, retrieve team context that answers it\nQuery: ';
export const EMBED_DIM = 1024;
export const CHAT_IDLE_MS = 5 * 60_000;

export interface ChatRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: unknown }[];
  schema: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LocalAiStatus {
  runtime: 'llama.cpp';
  binary: string;
  binaryFound: boolean;
  tier: string;
  models: ModelStatus[];
  servers: { chat: ServerInfo; embed: ServerInfo };
}
interface ServerInfo { state: ServerState; port: number; pid: number | null; restarts: number; lastError: string | null }

export interface LocalAi {
  ensureModels(onProgress?: (p: ModelsProgress) => void, roles?: readonly ModelRole[]): Promise<ModelStatus[]>;
  status(): Promise<LocalAiStatus>;
  /** One structured completion: temperature 0, constrained to `schema`. Returns the raw JSON text. */
  chat(request: ChatRequest): Promise<{ text: string; latencyMs: number }>;
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
  stop(): Promise<void>;
}

export interface LlamaLocalAiOptions {
  /** Directory holding `llama-server` and its dylibs (`process.resourcesPath/llama` when packaged). */
  llamaDir: string;
  /** `app.getPath('userData')/models` in the app. */
  modelsDir: string;
  plan: ModelPlan;
  /** Extra llama-server args for both servers (CI passes nothing; tests may pass `-ngl 0`). */
  extraArgs?: string[];
  chatContext?: number;
  chatIdleMs?: number;
  log?: (line: string) => void;
}

export function l2normalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  return v.map((x) => x / n);
}

export class LlamaLocalAi implements LocalAi {
  readonly store: ModelStore;
  readonly chatServer: LlamaServer;
  readonly embedServer: LlamaServer;
  readonly binary: string;

  constructor(private readonly opts: LlamaLocalAiOptions) {
    this.binary = join(opts.llamaDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    this.store = new ModelStore({ dir: opts.modelsDir, plan: opts.plan });
    const common = ['--no-webui', '--offline', '-ngl', '99', ...(opts.extraArgs ?? [])];
    // Pinned release b11046: thinking is disabled with `--reasoning off` + `--reasoning-budget 0`.
    this.chatServer = new LlamaServer({
      name: 'chat',
      binary: this.binary,
      args: ['-m', this.store.pathOf('llm'), '--jinja', '-c', String(opts.chatContext ?? 8192), '-np', '1', '--reasoning', 'off', '--reasoning-budget', '0', ...common],
      idleMs: opts.chatIdleMs ?? CHAT_IDLE_MS,
      log: opts.log,
    });
    this.embedServer = new LlamaServer({
      name: 'embed',
      binary: this.binary,
      args: ['-m', this.store.pathOf('embed'), '--embedding', '--pooling', 'last', '-c', '8192', '-ub', '2048', '-b', '2048', ...common],
      log: opts.log,
    });
  }

  ensureModels(onProgress?: (p: ModelsProgress) => void, roles?: readonly ModelRole[]): Promise<ModelStatus[]> {
    return this.store.ensure(onProgress, roles);
  }

  async status(): Promise<LocalAiStatus> {
    const info = (s: LlamaServer): ServerInfo => ({ state: s.state, port: s.port, pid: s.pid, restarts: s.restarts, lastError: s.lastError });
    return {
      runtime: 'llama.cpp',
      binary: this.binary,
      binaryFound: existsSync(this.binary),
      tier: this.opts.plan.llm.id,
      models: await this.store.status(),
      servers: { chat: info(this.chatServer), embed: info(this.embedServer) },
    };
  }

  /** Base URL for an OpenAI-compatible client, e.g. "http://127.0.0.1:51234/v1". Starts the chat server. */
  async chatBaseUrl(): Promise<string> {
    return `${await this.chatServer.ensureStarted()}/v1`;
  }

  async chat(request: ChatRequest): Promise<{ text: string; latencyMs: number }> {
    const base = await this.chatBaseUrl();
    const started = performance.now();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({
        model: this.opts.plan.llm.id,
        temperature: 0,
        stream: false,
        max_tokens: request.maxTokens ?? 2048,
        messages: request.messages,
        response_format: { type: 'json_schema', json_schema: { name: request.schema.name, schema: request.schema.schema, strict: true } },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    this.chatServer.touch();
    const raw = await res.text();
    if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${raw.slice(0, 500)}`);
    const body = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('chat answered without choices[0].message.content');
    return { text, latencyMs: Math.round(performance.now() - started) };
  }

  async embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const base = await this.embedServer.ensureStarted();
    const input = kind === 'query' ? texts.map((t) => QUERY_PREFIX + t) : texts;
    const res = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.opts.plan.embed.id, input, encoding_format: 'float' }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${raw.slice(0, 500)}`);
    const body = JSON.parse(raw) as { data?: { index: number; embedding: number[] }[] };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) throw new Error(`embeddings returned ${data.length} vectors for ${texts.length} texts`);
    return data.map((d) => l2normalise(d.embedding));
  }

  async stop(): Promise<void> {
    await Promise.all([this.chatServer.stop(), this.embedServer.stop()]);
  }

  /** Synchronous kill for `will-quit` / process exit handlers. */
  killNow(): void {
    this.chatServer.killNow();
    this.embedServer.killNow();
  }
}
