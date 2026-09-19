/**
 * HTTP adapter — UNTESTED against a live server.
 *
 * The OpenKT server work is in progress (docs/architecture.md §8, v0.1). This
 * adapter is deliberately thin: it covers only the endpoints that are already
 * agreed, maps the wire shapes defensively, and delegates everything the
 * server does not expose yet (spaces, pages, connectors, skills, models) to a
 * local MockClient so the app stays navigable. Each delegated method is
 * marked `// no endpoint yet`. Replace them one by one as the server lands.
 *
 * Endpoints used, shapes per docs/specs/04-api-contract.md:
 *   GET    /v1/sessions                     list (no turns)
 *   POST   /v1/sessions                     create
 *   GET    /v1/sessions/:id                 Session + facts[]
 *   GET    /v1/sessions/:id/turns           editors and owners only; 403 → no transcript
 *   POST   /v1/sessions/:id/close           close
 *   GET    /v1/sessions/:id/grants          list grants     (spaces: /v1/projects/:id/grants)
 *   PUT    /v1/sessions/:id/grants          upsert          {subject_id, role}
 *   DELETE /v1/grants/:grant_id             remove (the spec's path; looked up from the list)
 *   POST   /v1/memories/recall              {query, project_id?, k?} → {items}
 *
 * The server still calls a space a "project"; that name stops at this file.
 */
import type { OpenKTClient } from './client';
import { MockClient } from './mock';
import type {
  ContextItem,
  Grant,
  GrantSubject,
  Id,
  NewSessionInput,
  RecallHit,
  ResourceRef,
  Role,
  Session,
  SessionListItem,
  SessionSource,
} from './types';

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`OpenKT server ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

function unwrap(body: unknown, key: string): Json[] {
  if (Array.isArray(body)) return body as Json[];
  if (body && typeof body === 'object') return arr((body as Json)[key] ?? (body as Json)['data']);
  return [];
}

function toSession(j: Json, turns: Json[] = arr(j['turns'])): Session {
  const owner = (j['owner'] ?? {}) as Json;
  return {
    id: str(j['id']),
    source: str(j['source'], 'note') as SessionSource,
    title: str(j['title'], 'Untitled session'),
    summary: str(j['summary']),
    status: str(j['status']) === 'open' ? 'open' : 'closed',
    spaceId: str(j['space_id'] ?? j['project_id']),
    authorId: str(owner['id'] ?? j['author_id']),
    createdAt: str(j['started_at'] ?? j['created_at'], new Date().toISOString()),
    durationSec: num(j['duration_sec']),
    extractedOn: str(j['extracted_on']) === 'device' ? 'device' : 'server',
    turns: turns.map((t, i) => ({
      id: str(t['id'], `t${i + 1}`),
      speaker: str(t['speaker'] ?? t['role'], 'unknown'),
      at: Math.round((num(t['t0_ms']) ?? 0) / 1000),
      text: str(t['text'] ?? t['content']),
    })),
  };
}

function toGrant(j: Json, resource: ResourceRef): Grant {
  const subject = (j['subject'] ?? {}) as Json;
  const subjectId = str(subject['id'] ?? j['subject_id']);
  const name = str(subject['name'] ?? j['subject_name'], subjectId);
  const inheritedFrom = j['inherited_from'] as Json | string | undefined;
  return {
    id: str(j['id'], `${resource.id}:${subjectId}`),
    resource,
    subject: {
      type: str(subject['type'] ?? j['subject_type']) === 'team' ? 'team' : 'user',
      id: subjectId,
      name,
      initials: name
        .split(/\s+/)
        .map((w) => w[0] ?? '')
        .join('')
        .slice(0, 2)
        .toUpperCase(),
    },
    role: (['reader', 'editor', 'owner'].includes(str(j['role'])) ? str(j['role']) : 'reader') as Role,
    note: inheritedFrom ? 'inherited from the space' : str(subject['email']),
    inherited: Boolean(inheritedFrom),
  };
}

export class HttpClient implements OpenKTClient {
  readonly kind = 'http' as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new MockClient();
  private listeners = new Set<() => void>();

  constructor(opts: HttpClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.fallback.subscribe(() => this.changed());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new HttpError(res.status, path, await res.text().catch(() => ''));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private grantsPath(resource: ResourceRef): string {
    const id = encodeURIComponent(resource.id);
    return resource.type === 'space' ? `/v1/projects/${id}/grants` : `/v1/sessions/${id}/grants`;
  }

  // ── implemented against the server ────────────────────────────────────

  async listSessions(filter?: { spaceId?: Id; mine?: boolean }): Promise<SessionListItem[]> {
    const qs = new URLSearchParams();
    if (filter?.spaceId) qs.set('project_id', filter.spaceId);
    if (filter?.mine) qs.set('mine', 'true');
    const body = await this.request('GET', `/v1/sessions${qs.size ? `?${qs}` : ''}`);
    return unwrap(body, 'sessions').map((j) => {
      const { turns: _t, ...rest } = toSession(j);
      return rest;
    });
  }

  async getSession(id: Id): Promise<Session> {
    const path = `/v1/sessions/${encodeURIComponent(id)}`;
    const session = await this.request<Json>('GET', path);
    // Readers get facts, not transcripts: a 403 here is expected, not an error.
    const turns = await this.request('GET', `${path}/turns`).then(
      (body) => unwrap(body, 'turns'),
      (e: unknown) => {
        if (e instanceof HttpError && e.status === 403) return [];
        throw e;
      },
    );
    return toSession(session, turns);
  }

  async createSession(input: NewSessionInput): Promise<Session> {
    const j = await this.request<Json>('POST', '/v1/sessions', {
      source: input.source,
      title: input.title,
      project_id: input.spaceId,
      client: 'openkt-desktop',
    });
    const id = str(j['id']);
    if (input.text?.trim() && id) {
      await this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/turns`, { turns: [{ role: 'user', content: input.text }] });
    }
    this.changed();
    return toSession(j);
  }

  async closeSession(id: Id): Promise<Session> {
    const j = await this.request<Json>('POST', `/v1/sessions/${encodeURIComponent(id)}/close`, {});
    this.changed();
    return toSession(j);
  }

  async listGrants(resource: ResourceRef): Promise<Grant[]> {
    const body = await this.request('GET', this.grantsPath(resource));
    return unwrap(body, 'grants').map((j) => toGrant(j, resource));
  }

  async putGrant(resource: ResourceRef, subject: GrantSubject, role: Role): Promise<Grant> {
    const j = await this.request<Json | undefined>('PUT', this.grantsPath(resource), { subject_id: subject.id, role });
    this.changed();
    return j?.['id'] ? toGrant({ subject_name: subject.name, subject_id: subject.id, ...j }, resource) : { id: `${resource.id}:${subject.id}`, resource, subject, role, note: '' };
  }

  async deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id'>): Promise<void> {
    const grant = (await this.listGrants(resource)).find((g) => g.subject.id === subject.id);
    if (!grant) return;
    await this.request('DELETE', `/v1/grants/${encodeURIComponent(grant.id)}`);
    this.changed();
  }

  async recall(query: string, opts?: { spaceId?: Id; limit?: number }): Promise<RecallHit[]> {
    const body = await this.request('POST', '/v1/memories/recall', {
      query,
      project_id: opts?.spaceId,
      k: opts?.limit ?? 12,
    });
    return unwrap(body, 'items').map((j) => {
      const session = (j['session'] ?? {}) as Json;
      const page = (j['page'] ?? {}) as Json;
      const author = (j['author'] ?? {}) as Json;
      const isSection = str(j['type']) === 'section';
      return {
        id: str(j['id']),
        type: isSection ? ('page' as const) : ('context' as const),
        title: str(j['text']),
        meta: [str(author['name']), str(session['title'] ?? page['title'])].filter(Boolean).join(' · '),
        kind: (str(j['kind']) || undefined) as RecallHit['kind'],
        href: isSection && page['id'] ? `/pages/${str(page['id'])}` : session['id'] ? `/sessions/${str(session['id'])}/context` : '/',
      };
    });
  }

  /** Facts ride along on the session payload when the server includes them. */
  async listContext(sessionId: Id): Promise<ContextItem[]> {
    const j = await this.request<Json>('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`);
    const owner = (j['owner'] ?? {}) as Json;
    return arr(j['facts']).map((f, i) => ({
      id: str(f['id'], `f${i}`),
      kind: str(f['kind'], 'fact') as ContextItem['kind'],
      statement: str(f['statement'] ?? f['content']),
      quote: str(f['quote']) || undefined,
      author: str(((f['author'] ?? {}) as Json)['name'] ?? owner['name']),
      sessionId,
      spaceId: str(j['space_id'] ?? j['project_id']),
      tags: Array.isArray(f['tags']) ? (f['tags'] as string[]) : [],
      createdAt: str(f['created_at'], new Date().toISOString()),
    }));
  }

  // ── no endpoint yet: served by the local mock ──────────────────────────

  getWorkspace = () => this.fallback.getWorkspace(); // no endpoint yet
  listSpaces = () => this.fallback.listSpaces(); // no endpoint yet
  getSpace = (id: Id) => this.fallback.getSpace(id); // no endpoint yet
  listPages = (spaceId: Id) => this.fallback.listPages(spaceId); // no endpoint yet
  getPage = (id: Id) => this.fallback.getPage(id); // no endpoint yet
  searchSubjects = (q: string) => this.fallback.searchSubjects(q); // no endpoint yet
  listAccessDefaults = () => this.fallback.listAccessDefaults(); // no endpoint yet
  listConnectors = () => this.fallback.listConnectors(); // no endpoint yet
  updateConnector: OpenKTClient['updateConnector'] = (id, patch) => this.fallback.updateConnector(id, patch); // no endpoint yet
  listSkills = () => this.fallback.listSkills(); // no endpoint yet
  createSkill = (name: string) => this.fallback.createSkill(name); // no endpoint yet
  runSkill = (id: Id) => this.fallback.runSkill(id); // no endpoint yet
  getModelSettings = () => this.fallback.getModelSettings(); // local to the Mac, never a server call
  setModel: OpenKTClient['setModel'] = (job, name) => this.fallback.setModel(job, name);
  setModelEndpoint = (endpoint: string) => this.fallback.setModelEndpoint(endpoint);
}
