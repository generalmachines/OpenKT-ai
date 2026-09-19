import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readCredentials, type Credentials } from './credentials.js';
import type { FetchLike } from './server.js';
import type { ConnectEnv } from './types.js';

/**
 * The hook core in Node: the same protocol, state files and outbox as assets/openkt-hook.sh, for agents that call
 * `openkt-connect hook <tool> <event>` (or `kt hook`) instead of the sh script. Pure apart from the injected fetch,
 * clock and file system root, so it is tested against the same fake server as the script.
 *
 *   stdin   the tool's hook JSON (Claude Code, Codex, Gemini CLI, Cursor, Windsurf, or {session_id, cwd, prompt} from any agent)
 *   stdout  what that tool reads back: hookSpecificOutput.additionalContext, Cursor's additional_context, or {context_md}
 */
export type HookEvent = 'session-start' | 'prompt' | 'stop' | 'session-end' | 'native-memory';
export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'prompt', 'stop', 'session-end', 'native-memory'];

export interface HookDeps {
  env: ConnectEnv;
  fetch?: FetchLike;
  credentials?: Credentials;
  recallTimeoutMs?: number;
  writeTimeoutMs?: number;
  minSimilarity?: number;
  /** Where the tool runs when the hook JSON has no cwd. */
  cwd?: string;
}

export interface HookResult {
  stdout: string;
  exitCode: 0;
}

let outboxSeq = 0;
const CONTEXT_BUDGET = 1500;
const TURN_BUDGET = 8192;
const OUTBOX_CAP = 50 * 1024 * 1024;

type Obj = Record<string, unknown>;
const pick = (o: Obj, ...paths: string[]): unknown => {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p.split('.')) cur = cur && typeof cur === 'object' ? (cur as Obj)[k] : undefined;
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const safeKey = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

function cut(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = Buffer.from(s).subarray(0, max).toString('utf8');
  out = out.replace(/�+$/, '');
  return `${out}…`;
}

class Io {
  constructor(
    private readonly deps: HookDeps,
    readonly creds: Credentials,
  ) {}
  get home(): string {
    return this.deps.env.openktHome;
  }
  async http(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: Obj | null }> {
    if (!this.creds.token) return { status: 401, json: null };
    const f = this.deps.fetch ?? (fetch as unknown as FetchLike);
    try {
      const res = await f(`${this.creds.server}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.creds.token}`, Accept: 'application/json', 'User-Agent': 'openkt-connect-hook', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: Obj | null = null;
      try {
        json = text ? (JSON.parse(text) as Obj) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      return { status: 0, json: null };
    }
  }
  mapFile(key: string): string {
    return join(this.home, 'state', 'sessions', key);
  }
  async session(key: string, create: Obj | null, timeoutMs: number): Promise<string | null> {
    const file = this.mapFile(key);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim() || null;
    if (!create) return null;
    const res = await this.http('POST', '/v1/sessions', create, timeoutMs);
    const id = str(pick(res.json ?? {}, 'data.id'));
    if (res.status >= 200 && res.status < 300 && id) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, id);
      return id;
    }
    return null;
  }
  queue(key: string, create: Obj | null, method: string, path: string, body: unknown): void {
    const dir = join(this.home, 'outbox');
    mkdirSync(dir, { recursive: true });
    const files = () => readdirSync(dir).filter((n) => n.endsWith('.req')).sort();
    let size = files().reduce((a, n) => a + statSync(join(dir, n)).size, 0);
    for (const oldest of files()) {
      if (size <= OUTBOX_CAP) break;
      size -= statSync(join(dir, oldest)).size;
      rmSync(join(dir, oldest), { force: true });
    }
    const name = `${Math.floor(Date.now() / 1000)}-${process.pid}-${++outboxSeq}.req`;
    const lines = [`key ${key || '-'}`, `create ${create ? JSON.stringify(create) : '-'}`, `method ${method}`, `path ${path}`, `body ${body === undefined ? '-' : JSON.stringify(body)}`];
    writeFileSync(join(dir, name), `${lines.join('\n')}\n`, { mode: 0o600 });
  }
  async send(key: string, create: Obj | null, method: string, path: string, body: unknown): Promise<number> {
    let p = path;
    if (p.includes(':sid')) {
      const sid = await this.session(key, create, this.deps.writeTimeoutMs ?? 1500);
      if (!sid) {
        this.queue(key, create, method, path, body);
        return 0;
      }
      p = p.replace(':sid', sid);
    }
    const res = await this.http(method, p, body, this.deps.writeTimeoutMs ?? 1500);
    if (res.status >= 200 && res.status < 300) return res.status;
    if (retryable(res.status)) this.queue(key, create, method, path, body);
    return res.status;
  }
  async flush(): Promise<void> {
    const dir = join(this.home, 'outbox');
    if (!this.creds.token || !existsSync(dir)) return;
    const names = readdirSync(dir).filter((n) => n.endsWith('.req')).sort(byOutboxOrder);
    for (const name of names) {
      const file = join(dir, name);
      const fields = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
      const create = fields['create'] && fields['create'] !== '-' ? (JSON.parse(fields['create']) as Obj) : null;
      let path = fields['path'] ?? '';
      if (path.includes(':sid')) {
        const sid = await this.session(fields['key'] ?? '', create, this.deps.writeTimeoutMs ?? 5000);
        if (!sid) {
          if (!create) {
            rmSync(file, { force: true });
            continue;
          }
          break;
        }
        path = path.replace(':sid', sid);
      }
      const body = fields['body'] && fields['body'] !== '-' ? fields['body'] : undefined;
      const res = await this.http(fields['method'] ?? 'POST', path, body, this.deps.writeTimeoutMs ?? 5000);
      if ((res.status >= 200 && res.status < 300) || !retryable(res.status)) {
        rmSync(file, { force: true });
        if (path.endsWith('/close')) rmSync(this.mapFile(fields['key'] ?? ''), { force: true });
      } else break;
    }
  }
}

function retryable(status: number): boolean {
  return status === 0 || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;
}

function byOutboxOrder(a: string, b: string): number {
  const pa = a.split(/[-.]/).map(Number);
  const pb = b.split(/[-.]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** cwd → space id: nearest .openkt/manifest.json below $HOME, else ~/.openkt/folders.json; unknown git repos are noted. */
export function resolveSpace(env: ConnectEnv, cwd: string): string {
  let foldersJson: Record<string, { space_id?: string | null }> = {};
  try {
    foldersJson = (JSON.parse(readFileSync(join(env.openktHome, 'folders.json'), 'utf8')) as { folders?: typeof foldersJson }).folders ?? {};
  } catch {
    foldersJson = {};
  }
  let gitRoot = '';
  for (let d = cwd; d && d !== '/'; d = dirname(d)) {
    if (d !== env.home && existsSync(join(d, '.openkt', 'manifest.json'))) {
      try {
        const id = str((JSON.parse(readFileSync(join(d, '.openkt', 'manifest.json'), 'utf8')) as Obj)['project_id']);
        if (id) return id;
      } catch {
        // Unreadable manifest: keep walking.
      }
    }
    if (d in foldersJson) return foldersJson[d]?.space_id ?? '';
    if (!gitRoot && existsSync(join(d, '.git'))) gitRoot = d;
    if (dirname(d) === d) break;
  }
  if (gitRoot) {
    const pending = join(env.openktHome, 'folders.pending');
    const seen = existsSync(pending) && readFileSync(pending, 'utf8').split('\n').some((l) => l.split('\t')[0] === gitRoot);
    if (!seen) {
      mkdirSync(env.openktHome, { recursive: true });
      writeFileSync(pending, `${gitRoot}\t${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`, { flag: 'a' });
    }
  }
  return '';
}

interface MemoryItem {
  content?: string;
  owner?: { display_name?: string };
  project?: { name?: string };
  created_at?: string;
  similarity?: number;
}

export function formatItems(items: MemoryItem[], head: string, minSimilarity: number): string {
  let out = '';
  for (const it of items) {
    if (!it.content) continue;
    if (minSimilarity > 0 && typeof it.similarity === 'number' && it.similarity < minSimilarity) continue;
    let line = `- ${cut(it.content, 400)} — ${it.owner?.display_name || 'someone'}`;
    if (it.project?.name) line += `, ${it.project.name}`;
    if (it.created_at) line += `, ${it.created_at.slice(0, 10)}`;
    if (out.length + line.length + 2 > CONTEXT_BUDGET - head.length) break;
    out += `${line}\n`;
  }
  return out ? head + out : '';
}

function emit(tool: string, event: HookEvent, context: string): string {
  const ctx = context;
  const hso = (name: string) => (ctx ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: ctx } })}\n` : '');
  switch (`${tool}:${event}`) {
    case 'claude-code:session-start':
    case 'codex:session-start':
    case 'gemini:session-start':
      return hso('SessionStart');
    case 'claude-code:prompt':
    case 'codex:prompt':
      return hso('UserPromptSubmit');
    case 'gemini:prompt':
      return hso('BeforeAgent');
    case 'cursor:session-start':
      return ctx ? `${JSON.stringify({ additional_context: ctx })}\n` : '';
    case 'cursor:prompt':
      return '{"continue":true}\n';
    case 'agent:session-start':
    case 'agent:prompt':
      return `${JSON.stringify({ context_md: ctx })}\n`;
    default:
      return '';
  }
}

const KIND: Record<string, string> = { feedback: 'anti-pattern', project: 'decision', reference: 'context', user: 'context' };

export async function runHook(tool: string, event: HookEvent, stdinJson: string, deps: HookDeps): Promise<HookResult> {
  const ok = (stdout = ''): HookResult => ({ stdout, exitCode: 0 });
  let input: Obj = {};
  try {
    const parsed = JSON.parse(stdinJson || '{}') as unknown;
    if (parsed && typeof parsed === 'object') input = parsed as Obj;
  } catch {
    input = {};
  }
  const creds = deps.credentials ?? (await readCredentials(deps.env));
  const io = new Io(deps, creds);
  const csid = str(pick(input, 'session_id', 'conversation_id', 'trajectory_id', 'sessionId')) || `ppid-${process.ppid}`;
  const cwd = str(pick(input, 'cwd', 'workspace_roots.0')) || deps.cwd || '';
  const key = `${safeKey(tool)}__${safeKey(csid)}`;
  const space = cwd ? resolveSpace(deps.env, cwd) : '';
  const create: Obj = {
    source: tool === 'claude-code' ? 'claude-code' : 'connector',
    client: tool,
    title: basename(cwd) || `${tool} session`,
    metadata: { cwd, client_session_id: csid, via: 'openkt-connect' },
    ...(space ? { project_id: space } : {}),
  };
  const withSpace = (o: Obj): Obj => (space ? { ...o, project_id: space } : o);
  const recallTimeout = deps.recallTimeoutMs ?? 1200;

  try {
    switch (event) {
      case 'session-start': {
        if (!creds.token) return ok(emit(tool, event, ''));
        const created = existsSync(io.mapFile(key)) ? Promise.resolve(null) : io.session(key, create, 1500);
        const prime = await io.http('POST', '/v1/prime', withSpace({ with_briefing: true }), recallTimeout);
        let ctx = '';
        if (prime.status >= 200 && prime.status < 300) {
          const name = str(pick(prime.json ?? {}, 'data.project.name')) || 'Personal';
          const summary = str(pick(prime.json ?? {}, 'data.briefing.summary'));
          let head = `OpenKT: shared context for this work (space: ${name}). Cite the author when you use it.\n`;
          if (summary) head += `${cut(summary, 600)}\n`;
          const list = formatItems((pick(prime.json ?? {}, 'data.memories') as MemoryItem[]) ?? [], 'Recent context:\n', 0);
          ctx = head + (list || 'Nothing saved in this space yet. Save decisions with kt_save_memory as they happen.\n');
        }
        await created;
        const sid = existsSync(io.mapFile(key)) ? readFileSync(io.mapFile(key), 'utf8').trim() : '';
        if (sid) ctx += `This conversation is already saved as OpenKT session ${sid} by hooks: pass session_id "${sid}" to kt_recall and kt_save_memory, and do not call kt_session_start or kt_session_end.\n`;
        await io.flush();
        return ok(emit(tool, event, ctx));
      }
      case 'prompt': {
        const prompt = str(pick(input, 'prompt', 'tool_info.user_prompt'));
        if (!prompt) return ok(emit(tool, event, ''));
        const turn = { role: 'user', content: cut(prompt, TURN_BUDGET), metadata: { via: 'openkt-connect' } };
        if (!creds.token) {
          io.queue(key, create, 'POST', '/v1/sessions/:sid/turns', turn);
          return ok(emit(tool, event, ''));
        }
        const write = io.send(key, create, 'POST', '/v1/sessions/:sid/turns', turn);
        let ctx = '';
        if (prompt.length >= 12) {
          const res = await io.http('POST', '/v1/memories/recall', withSpace({ query: cut(prompt, 1900), limit: 5 }), recallTimeout);
          if (res.status >= 200 && res.status < 300) {
            ctx = formatItems((pick(res.json ?? {}, 'data') as MemoryItem[]) ?? [], 'Context from OpenKT that may be relevant (cite the author if you use it):\n', deps.minSimilarity ?? 0.5);
          }
        }
        await write;
        await io.flush();
        return ok(emit(tool, event, ctx));
      }
      case 'stop': {
        const text = str(pick(input, 'last_assistant_message', 'text', 'prompt_response', 'tool_info.response'));
        if (!text) return ok();
        const turn = { role: 'assistant', content: cut(text, TURN_BUDGET), metadata: { via: 'openkt-connect' } };
        if (!creds.token) io.queue(key, create, 'POST', '/v1/sessions/:sid/turns', turn);
        else await io.send(key, create, 'POST', '/v1/sessions/:sid/turns', turn);
        return ok();
      }
      case 'session-end': {
        const mapped = existsSync(io.mapFile(key));
        if (!creds.token) {
          if (mapped) io.queue(key, null, 'POST', '/v1/sessions/:sid/close', {});
          return ok();
        }
        await io.flush();
        if (existsSync(io.mapFile(key))) {
          const status = await io.send(key, null, 'POST', '/v1/sessions/:sid/close', {});
          if (status >= 200 && status < 300) rmSync(io.mapFile(key), { force: true });
        }
        return ok();
      }
      case 'native-memory': {
        if (!creds.token) return ok();
        const fact = str(pick(input, 'tool_input.fact', 'tool_args.fact'));
        const file = str(pick(input, 'tool_input.file_path', 'tool_input.path', 'file_path'));
        if (tool === 'gemini' && fact) await saveNative(io, `gemini:${fact}`, fact, 'note', 'gemini', withSpace);
        else if (/\/\.claude(-accounts\/[^/]+)?\/projects\/[^/]+\/memory\/[^/]+\.md$/.test(file) && basename(file) !== 'MEMORY.md' && existsSync(file)) {
          const text = readFileSync(file, 'utf8');
          const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
          const meta = Object.fromEntries((fm?.[1] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '')]));
          const body = fm ? text.slice(fm[0].length) : text;
          if (body.trim()) {
            const type = (meta['type'] ?? '').toLowerCase();
            const tag = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(type) ? type : '';
            await saveNative(io, `claude-code:${file}`, `${meta['name'] || basename(file)}\n\n${cut(body.replace(/\n$/, ''), 18000)}`, KIND[type] ?? 'note', tag, withSpace);
          }
        }
        return ok();
      }
    }
  } catch {
    // A hook never fails the tool.
  }
  return ok();
}

async function saveNative(io: Io, id: string, content: string, kind: string, tag: string, withSpace: (o: Obj) => Obj): Promise<void> {
  const { createHash } = await import('node:crypto');
  const file = join(io.home, 'state', 'native', safeKey(createHash('sha256').update(id).digest('hex')));
  const hash = createHash('sha256').update(content).digest('hex');
  const [oldHash, oldId] = existsSync(file) ? readFileSync(file, 'utf8').trim().split(' ') : [];
  if (oldHash === hash) return;
  const res = await io.http('POST', '/v1/memories', withSpace({ content, kind, tag_slugs: ['native-memory', ...(tag ? [tag] : [])], source_refs: [] }), 5000);
  const newId = str(pick(res.json ?? {}, 'data.id'));
  if (res.status >= 200 && res.status < 300) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${hash} ${newId || '-'}\n`);
    if (oldId && oldId !== '-') await io.http('DELETE', `/v1/memories/${oldId}`, undefined, 5000);
  } else if (retryable(res.status)) {
    io.queue('-', null, 'POST', '/v1/memories', withSpace({ content, kind, tag_slugs: ['native-memory', ...(tag ? [tag] : [])], source_refs: [] }));
  }
}
