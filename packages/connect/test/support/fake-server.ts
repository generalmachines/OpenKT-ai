import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
  raw: string;
}

export interface FakeOptions {
  token?: string;
  /** Milliseconds to wait before answering, per "METHOD /path-prefix". */
  delays?: Record<string, number>;
  /** Status to answer with, per "METHOD /path-prefix" (e.g. 503 to simulate an outage). */
  failures?: Record<string, number>;
  memories?: Array<Record<string, unknown>>;
}

/** Just enough of the OpenKT API (Spec 04 shapes, {data,error,meta} envelope) for the hook script and runHook. */
export class FakeServer {
  readonly requests: Recorded[] = [];
  readonly sessions = new Map<string, { id: string; project_id: string; status: string; turns: { role: string; content: string }[]; body: Record<string, unknown> }>();
  readonly memories: Array<Record<string, unknown>>;
  url = '';
  private server: Server | null = null;

  constructor(readonly options: FakeOptions = {}) {
    this.memories = options.memories ?? [];
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  of(method: string, prefix: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  async waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return pred();
  }

  private match(table: Record<string, number> | undefined, method: string, path: string): number | undefined {
    for (const [k, v] of Object.entries(table ?? {})) {
      const [m, p] = k.split(' ');
      if (m === method && path.startsWith(p ?? '')) return v;
    }
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { __invalid_json: raw };
    }
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0]!;
    this.requests.push({ method, path, auth: req.headers.authorization, body, raw });
    const delay = this.match(this.options.delays, method, path);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(status < 400 ? { data, error: null, meta: null } : { data: null, error: data, meta: null }));
    };
    const fail = this.match(this.options.failures, method, path);
    if (fail) return send(fail, { code: 'server', message: 'simulated' });
    if (this.options.token && req.headers.authorization !== `Bearer ${this.options.token}`) return send(401, { code: 'unauthorized', message: 'authorization bearer token required' });
    const b = (body ?? {}) as Record<string, unknown>;

    if (method === 'POST' && path === '/v1/sessions') {
      const id = randomUUID();
      const s = { id, project_id: String(b['project_id'] ?? 'personal-space'), status: 'open', turns: [], body: b };
      this.sessions.set(id, s);
      return send(201, { id, project_id: s.project_id, status: 'open', source: b['source'], client: b['client'], title: b['title'] });
    }
    let m = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
    if (method === 'POST' && m) {
      const s = this.sessions.get(m[1]!);
      if (!s) return send(404, { code: 'not_found', message: 'session' });
      s.turns.push({ role: String(b['role']), content: String(b['content']) });
      return send(201, { id: randomUUID(), session_id: s.id, seq: s.turns.length, role: b['role'], content: b['content'] });
    }
    m = /^\/v1\/sessions\/([^/]+)\/close$/.exec(path);
    if (method === 'POST' && m) {
      const s = this.sessions.get(m[1]!);
      if (!s) return send(404, { code: 'not_found', message: 'session' });
      s.status = 'closed';
      return send(200, { id: s.id, status: 'closed' });
    }
    if (method === 'POST' && path === '/v1/prime') {
      return send(200, { project: { id: 'personal-space', name: b['project_id'] ? 'Acme' : 'Personal' }, memories: this.memories, briefing: { summary: 'The team ships on Fridays.' } });
    }
    if (method === 'POST' && path === '/v1/memories/recall') {
      return send(200, this.memories);
    }
    if (method === 'POST' && path === '/v1/memories') {
      const id = randomUUID();
      this.memories.push({ id, ...b, owner: { display_name: 'Test Person' }, created_at: '2026-09-19T10:00:00Z', similarity: 0.9 });
      return send(201, { id, content: b['content'] });
    }
    m = /^\/v1\/memories\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && m) return send(200, { archived: true });
    if (method === 'POST' && path === '/mcp') {
      const rpc = b as { id?: unknown; method?: string };
      if (rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-mcp-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { echo: rpc.method, session: req.headers['mcp-session-id'] ?? null } }));
      return;
    }
    return send(404, { code: 'not_found', message: `${method} ${path}` });
  }
}

export function memory(content: string, author: string, similarity = 0.9): Record<string, unknown> {
  return { id: randomUUID(), content, owner: { display_name: author }, project: { name: 'Personal' }, created_at: '2026-09-18T09:00:00Z', similarity };
}
