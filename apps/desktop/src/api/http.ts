/**
 * HTTP adapter for the OpenKT server as it exists today
 * (server/apps/server/src/modules/**). Where docs/specs/04-api-contract.md
 * and the server disagree, this file follows the server; each difference is
 * marked `SPEC-04:` so it can be reconciled.
 *
 * Every response is wrapped: `{ data, error: null, meta }` on success,
 * `{ error: { code, message } }` on failure.
 *
 *   GET    /v1/me                          profile {user_id, display_name, email, …}
 *   GET    /v1/projects/personal           get-or-create the personal space
 *   GET    /v1/projects · /v1/projects/:id {id, slug, name, visibility, org_id, owner_user_id, …}
 *   GET    /v1/orgs · /v1/orgs/slug/:slug/members   people for the invite field
 *   GET    /v1/sessions?project_id=        one project per call; none → the personal space
 *   POST   /v1/sessions                    {project_id, source, client, title}
 *   POST   /v1/sessions/:id/turns          ONE turn per call: {role, content}
 *   POST   /v1/sessions/:id/close          {summary}
 *   GET    /v1/sessions/:id                {session, turns, memories}
 *   POST   /v1/memories                    {content, kind, project_id, session_id}
 *   DELETE /v1/memories/:id
 *   POST   /v1/memories/recall             {query, project_id?, limit} → data: Memory[]
 *   GET    /v1/{sessions|projects}/:id/grants          owner only → GrantRecord[]
 *   PUT    /v1/{sessions|projects}/:id/grants/:userId  {role}
 *   DELETE /v1/{sessions|projects}/:id/grants/:userId
 *
 * The server says project and memory; the app says space and context. Those
 * words stop at this file. Pages, skills, connectors, access defaults, teams
 * and models have no endpoint: they come from the local mock and are listed
 * in `preview` so their screens carry a "sample data" badge.
 */
import type { NetRequest, NetResponse } from '../shared/ipc';
import { netRequest } from './bridge';
import { NotFoundError, type OpenKTClient } from './client';
import { ApiError, kindForStatus } from './errors';
import { MockClient } from './mock';
import type {
  ContextItem,
  ContextKind,
  Grant,
  GrantSubject,
  Id,
  Me,
  NewFactInput,
  NewSessionInput,
  PreviewArea,
  RecallHit,
  ResourceRef,
  Role,
  Session,
  SessionListItem,
  SessionSource,
  Space,
  Workspace,
} from './types';

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Called once per 401 so the app can drop to the signed-out state. */
  onUnauthorized?: () => void;
}

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
/** The wire is snake_case (a response interceptor converts the repositories' camelCase); both are accepted. */
const pick = (j: Json, snake: string): unknown => j[snake] ?? j[snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())];
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

export const initialsOf = (name: string): string =>
  name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

const APP_SOURCES: readonly SessionSource[] = ['meeting', 'claude-code', 'cursor', 'chatgpt', 'claude', 'hermes', 'voice', 'screenshot', 'note'];

/** SPEC-04: the server's sources add `mcp` and `connector` and lack `cursor`/`hermes`; `client` disambiguates. */
function toSource(source: string, client: string): SessionSource {
  if ((APP_SOURCES as readonly string[]).includes(source)) return source as SessionSource;
  const hint = APP_SOURCES.find((s) => client.toLowerCase().includes(s));
  return hint ?? (source === 'mcp' ? 'claude-code' : 'note');
}

const SERVER_SOURCES = new Set(['claude-code', 'chatgpt', 'claude', 'mcp', 'voice', 'meeting', 'screenshot', 'note', 'connector']);
const fromSource = (s: SessionSource): string => (SERVER_SOURCES.has(s) ? s : 'connector');

const APP_KINDS: readonly ContextKind[] = ['decision', 'action', 'fact', 'question', 'how-to', 'idea', 'issue'];

/**
 * SPEC-04: memory kinds are the server's older list (decision, pattern,
 * incident, …, note, fact). The app's kind rides in `category` so it
 * survives the round trip; memories saved elsewhere map by meaning.
 */
function toKind(kind: string, category: string): ContextKind {
  if ((APP_KINDS as readonly string[]).includes(category)) return category as ContextKind;
  if (kind === 'decision') return 'decision';
  if (kind === 'incident' || kind === 'anti-pattern') return 'issue';
  if (kind === 'pattern' || kind === 'skill' || kind === 'debug-recipe') return 'how-to';
  return 'fact';
}

function fromKind(kind: ContextKind): string {
  if (kind === 'decision' || kind === 'fact') return kind;
  if (kind === 'issue') return 'incident';
  if (kind === 'how-to') return 'pattern';
  return 'note';
}

function toSession(j: Json, turns: Json[] = []): Session {
  const startedAt = str(j['started_at'] ?? j['created_at'], new Date().toISOString());
  const endedAt = str(j['ended_at']);
  const source = toSource(str(j['source'], 'note'), str(j['client']));
  const start = Date.parse(startedAt);
  return {
    id: str(j['id']),
    source,
    title: str(j['title'], 'Untitled session'),
    summary: str(j['summary']),
    status: str(j['status']) === 'open' ? 'open' : 'closed',
    spaceId: str(j['project_id']),
    authorId: str(j['owner_user_id']),
    createdAt: startedAt,
    durationSec: endedAt && (source === 'meeting' || source === 'voice') ? Math.max(0, Math.round((Date.parse(endedAt) - start) / 1000)) : undefined,
    extractedOn: str(obj(j['metadata'])['extracted_on']) === 'device' ? 'device' : 'server',
    turns: turns.map((t, i) => ({
      id: str(t['id'], `t${i + 1}`),
      speaker: str(obj(t['metadata'])['speaker'], str(t['role'], 'unknown')),
      at: Math.max(0, Math.round((Date.parse(str(t['created_at'], startedAt)) - start) / 1000)),
      text: str(t['content']),
    })),
  };
}

function toContext(m: Json): ContextItem {
  const owner = obj(m['owner']);
  return {
    id: str(m['id']),
    kind: toKind(str(m['kind']), str(m['category'])),
    statement: str(m['content']),
    author: str(owner['display_name'], str(owner['email'], 'unknown')),
    sessionId: str(m['session_id']),
    spaceId: str(m['project_id']),
    tags: arr(m['tags'])
      .map((t) => str(t['slug']))
      .filter(Boolean),
    createdAt: str(m['created_at'], new Date().toISOString()),
    supersededBy: str(m['superseded_by']) || undefined,
  };
}

interface Member {
  id: Id;
  name: string;
  email: string;
}

export class HttpClient implements OpenKTClient {
  readonly kind = 'http' as const;
  readonly preview: ReadonlySet<PreviewArea> = new Set<PreviewArea>(['pages', 'skills', 'connectors', 'access-defaults', 'models', 'teams']);
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch | null;
  private readonly onUnauthorized?: () => void;
  private readonly fallback = new MockClient();
  private listeners = new Set<() => void>();
  private me?: Promise<Me>;
  private members?: Promise<Member[]>;
  private personalId?: Promise<Id>;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    this.token = opts.token.trim();
    this.fetchImpl = opts.fetch ?? null;
    this.onUnauthorized = opts.onUnauthorized;
    this.fallback.subscribe(() => this.changed());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    this.changed();
  }

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }

  // ── transport ─────────────────────────────────────────────────────────

  /** An injected fetch wins (tests); then main's proxy (packaged app, no CORS); then window.fetch. */
  private async send(req: NetRequest): Promise<NetResponse> {
    const viaMain = this.fetchImpl ? null : netRequest();
    if (viaMain) return viaMain(req);
    const res = await (this.fetchImpl ?? globalThis.fetch.bind(globalThis))(req.url, { method: req.method, headers: req.headers, body: req.body });
    return { status: res.status, body: await res.text() };
  }

  /** Returns the whole envelope; most callers want `.data`. */
  private async call(method: NetRequest['method'], path: string, body?: unknown): Promise<{ data: unknown; meta: Json }> {
    let res: NetResponse;
    try {
      res = await this.send({
        url: `${this.baseUrl}/v1${path}`,
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError('network', e instanceof Error ? e.message : String(e), 0, '', path);
    }
    let parsed: Json = {};
    try {
      parsed = res.body ? obj(JSON.parse(res.body)) : {};
    } catch {
      if (res.status >= 200 && res.status < 300) throw new ApiError('not-found', 'The server did not answer with JSON.', res.status, 'not_json', path);
    }
    if (res.status < 200 || res.status >= 300) {
      const err = obj(parsed['error']);
      const error = new ApiError(kindForStatus(res.status), str(err['message'], str(parsed['message'], `The server answered ${res.status}.`)), res.status, str(err['code']), path);
      if (error.kind === 'unauthorized') this.onUnauthorized?.();
      throw error;
    }
    return { data: parsed['data'], meta: obj(parsed['meta']) };
  }

  private async data(method: NetRequest['method'], path: string, body?: unknown): Promise<unknown> {
    return (await this.call(method, path, body)).data;
  }

  // ── people ────────────────────────────────────────────────────────────

  getMe(): Promise<Me> {
    this.me ??= this.data('GET', '/me').then((d) => {
      const j = obj(d);
      const email = str(j['email']);
      const name = str(pick(j, 'display_name'), email || 'You');
      return { id: str(pick(j, 'user_id')), name, email, initials: initialsOf(name) };
    });
    this.me.catch(() => (this.me = undefined));
    return this.me;
  }

  /** Everyone in the caller's orgs. SPEC-04 has no people endpoint; this is `/v1/orgs/slug/:slug/members`. */
  private listMembers(): Promise<Member[]> {
    this.members ??= (async () => {
      const orgs = arr(await this.data('GET', '/orgs'));
      const lists = await Promise.all(orgs.map((o) => this.data('GET', `/orgs/slug/${encodeURIComponent(str(o['slug']))}/members`).then(arr, () => [])));
      const seen = new Map<Id, Member>();
      for (const m of lists.flat()) {
        const id = str(pick(m, 'user_id'));
        const email = str(m['email']);
        if (id && !seen.has(id))
          seen.set(id, {
            id,
            email,
            name: str(pick(m, 'display_name'), email || id.slice(0, 8)),
          });
      }
      return [...seen.values()];
    })();
    this.members.catch(() => (this.members = undefined));
    return this.members;
  }

  async getWorkspace(): Promise<Workspace> {
    const [me, members, orgs] = await Promise.all([this.getMe(), this.listMembers().catch(() => []), this.data('GET', '/orgs').then(arr, () => [])]);
    const people = members.map((m) => ({
      id: m.id,
      name: m.name,
      initials: initialsOf(m.name),
    }));
    if (!people.some((p) => p.id === me.id)) people.unshift({ id: me.id, name: me.name, initials: me.initials });
    const org = orgs[0];
    return {
      id: str(org?.['id'], 'personal'),
      name: str(org?.['name'], new URL(this.baseUrl).host),
      me: { id: me.id, name: me.name, initials: me.initials },
      people,
      teams: [],
    };
  }

  async searchSubjects(query: string): Promise<GrantSubject[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const me = await this.getMe();
    // No org → no directory to search (there is no user-lookup endpoint). A pasted user id still works.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(q) && q !== me.id) return [{ type: 'user', id: q, name: `user ${q.slice(0, 8)}`, initials: '··' }];
    return (await this.listMembers())
      .filter((m) => m.id !== me.id && `${m.name} ${m.email}`.toLowerCase().includes(q))
      .map((m) => ({
        type: 'user' as const,
        id: m.id,
        name: m.name,
        initials: initialsOf(m.name),
      }));
  }

  // ── spaces ────────────────────────────────────────────────────────────

  private personal(): Promise<Id> {
    this.personalId ??= this.data('GET', '/projects/personal').then((d) => str(obj(d)['id']));
    this.personalId.catch(() => (this.personalId = undefined));
    return this.personalId;
  }

  private toSpace(j: Json, personalId: Id, sessionCount = 0): Space {
    const personal = str(j['id']) === personalId;
    return {
      id: str(j['id']),
      name: personal ? 'Personal' : str(j['name'], str(j['slug'])),
      slug: personal ? 'personal' : str(j['slug']),
      description: personal ? 'Only you can see this space.' : '',
      personal,
      memberCount: 0,
      pageCount: 0,
      sessionCount,
      updatedAt: str(pick(j, 'updated_at'), new Date().toISOString()),
    };
  }

  async listSpaces(): Promise<Space[]> {
    const personalId = await this.personal();
    const projects = arr(await this.data('GET', '/projects'));
    // The list has no counts; `meta.total` of a one-row session list is the cheapest honest number.
    const counts = await Promise.all(
      projects.map((p) =>
        this.call('GET', `/sessions?project_id=${encodeURIComponent(str(p['id']))}&limit=1`).then(
          (r) => Number(r.meta['total'] ?? 0),
          () => 0,
        ),
      ),
    );
    const spaces = projects.map((p, i) => this.toSpace(p, personalId, counts[i]));
    return spaces.sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));
  }

  async getSpace(id: Id): Promise<Space> {
    const [personalId, project, sessions] = await Promise.all([
      this.personal(),
      this.data('GET', `/projects/${encodeURIComponent(id)}`),
      this.call('GET', `/sessions?project_id=${encodeURIComponent(id)}&limit=1`).catch(() => null),
    ]);
    return this.toSpace(obj(project), personalId, Number(sessions?.meta['total'] ?? 0));
  }

  // ── sessions ──────────────────────────────────────────────────────────

  /**
   * SPEC-04: `GET /v1/sessions` is scoped to ONE project (none → personal),
   * not "every session the caller may read". "All" is a fan-out over
   * the visible projects, merged newest first.
   */
  async listSessions(filter?: { spaceId?: Id; mine?: boolean }): Promise<SessionListItem[]> {
    const ids = filter?.spaceId ? [filter.spaceId] : arr(await this.data('GET', '/projects')).map((p) => str(p['id']));
    if (!filter?.spaceId) {
      const personalId = await this.personal();
      if (!ids.includes(personalId)) ids.push(personalId);
    }
    const lists = await Promise.all(ids.map((id) => this.data('GET', `/sessions?project_id=${encodeURIComponent(id)}&limit=100`).then(arr, () => [])));
    const me = filter?.mine ? (await this.getMe()).id : null;
    return lists
      .flat()
      .map((j) => {
        const { turns: _t, ...rest } = toSession(j);
        return rest;
      })
      .filter((s) => (me ? s.authorId === me : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** SPEC-04: one call returns `{session, turns, memories}`; there is no separate `/turns` and no `my_role`. */
  private async sessionPayload(id: Id): Promise<{ session: Json; turns: Json[]; memories: Json[] }> {
    const d = obj(await this.data('GET', `/sessions/${encodeURIComponent(id)}`));
    if (!obj(d['session'])['id']) throw new NotFoundError('session', id);
    return {
      session: obj(d['session']),
      turns: arr(d['turns']),
      memories: arr(d['memories']),
    };
  }

  async getSession(id: Id): Promise<Session> {
    const { session, turns } = await this.sessionPayload(id);
    return toSession(session, turns);
  }

  async listContext(sessionId: Id): Promise<ContextItem[]> {
    const { memories } = await this.sessionPayload(sessionId);
    return memories.filter((m) => m['archived'] !== true).map(toContext);
  }

  async createSession(input: NewSessionInput): Promise<Session> {
    const j = obj(
      await this.data('POST', '/sessions', {
        project_id: input.spaceId || undefined,
        source: fromSource(input.source),
        client: 'openkt-desktop',
        title: input.title.trim().slice(0, 200) || null,
        metadata: { extracted_on: 'device' },
      }),
    );
    const id = str(j['id']);
    const turns: Json[] = [];
    // SPEC-04: one turn per call, 50 000 characters each, and no `note` role — captures go in as `user`.
    for (const text of (input.turns?.length ? input.turns : [input.text ?? '']).map((t) => t.trim()).filter(Boolean)) {
      for (let i = 0; i < text.length; i += 50_000) {
        turns.push(obj(await this.data('POST', `/sessions/${encodeURIComponent(id)}/turns`, { role: 'user', content: text.slice(i, i + 50_000) })));
      }
    }
    this.changed();
    return toSession(j, turns);
  }

  async closeSession(id: Id, summary?: string): Promise<Session> {
    const j = obj(
      await this.data('POST', `/sessions/${encodeURIComponent(id)}/close`, {
        summary: summary?.trim() || null,
      }),
    );
    this.changed();
    return toSession(j);
  }

  /** SPEC-04: there is no `POST /v1/sessions/:id/facts`; a fact is a memory created with `session_id`. */
  async saveFact(input: NewFactInput): Promise<ContextItem> {
    const kind = input.kind ?? 'fact';
    const m = obj(
      await this.data('POST', '/memories', {
        content: input.statement.trim(),
        kind: fromKind(kind),
        category: kind,
        project_id: input.spaceId || undefined,
        session_id: input.sessionId,
        visibility: 'project',
      }),
    );
    this.changed();
    return {
      ...toContext({
        project_id: input.spaceId,
        session_id: input.sessionId,
        ...m,
      }),
      kind,
    };
  }

  async deleteFact(id: Id): Promise<void> {
    await this.data('DELETE', `/memories/${encodeURIComponent(id)}`);
    this.changed();
  }

  // ── access ────────────────────────────────────────────────────────────

  private grantsPath(resource: ResourceRef): string {
    return `/${resource.type === 'space' ? 'projects' : 'sessions'}/${encodeURIComponent(resource.id)}/grants`;
  }

  /**
   * SPEC-04: grants are bare rows `{id, subject_id, role, …}` — no `subject`
   * object, no `inherited_from`, users only. Names are joined from the org
   * member list here. Listing is owner-only: a 403/404 means "not yours to
   * manage" and reads as an empty list rather than an error.
   */
  async listGrants(resource: ResourceRef): Promise<Grant[]> {
    let rows: Json[];
    try {
      rows = arr(await this.data('GET', this.grantsPath(resource)));
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'forbidden' || e.kind === 'not-found')) return [];
      throw e;
    }
    const [me, members, ownerId] = await Promise.all([this.getMe(), this.listMembers().catch(() => [] as Member[]), this.ownerOf(resource).catch(() => '')]);
    const person = (id: Id) => (id === me.id ? me : members.find((x) => x.id === id));
    const grants = rows.map((g): Grant => {
      const subjectId = str(g['subject_id']);
      const m = person(subjectId);
      const name = m?.name ?? `user ${subjectId.slice(0, 8)}`;
      return {
        id: str(g['id'], `${resource.id}:${subjectId}`),
        resource,
        subject: { type: 'user', id: subjectId, name, initials: m ? initialsOf(name) : '··' },
        role: (['reader', 'editor', 'owner'] as const).find((r) => r === g['role']) ?? 'reader',
        note: [m?.email, str(g['created_by']) === me.id ? 'added by you' : ''].filter(Boolean).join(' · '),
      };
    });
    // The owner holds no grant row on the server (ownership is a column), but the Access tab must show them.
    if (ownerId && !grants.some((g) => g.subject.id === ownerId)) {
      const m = person(ownerId);
      const name = m?.name ?? `user ${ownerId.slice(0, 8)}`;
      grants.unshift({
        id: `${resource.id}:owner`,
        resource,
        subject: { type: 'user', id: ownerId, name, initials: m ? initialsOf(name) : '··' },
        role: 'owner',
        note: ownerId === me.id ? `you · created this ${resource.type}` : `created this ${resource.type}`,
        inherited: true,
      });
    }
    return grants;
  }

  private async ownerOf(resource: ResourceRef): Promise<Id> {
    if (resource.type === 'space') return str(pick(obj(await this.data('GET', `/projects/${encodeURIComponent(resource.id)}`)), 'owner_user_id'));
    return str((await this.sessionPayload(resource.id)).session['owner_user_id']);
  }

  async putGrant(resource: ResourceRef, subject: GrantSubject, role: Role): Promise<Grant> {
    const g = obj(await this.data('PUT', `${this.grantsPath(resource)}/${encodeURIComponent(subject.id)}`, { role }));
    this.changed();
    return {
      id: str(g['id'], `${resource.id}:${subject.id}`),
      resource,
      subject,
      role,
      note: 'added by you',
    };
  }

  async deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id'>): Promise<void> {
    await this.data('DELETE', `${this.grantsPath(resource)}/${encodeURIComponent(subject.id)}`);
    this.changed();
  }

  // ── recall ────────────────────────────────────────────────────────────

  /**
   * SPEC-04: the body takes `limit` (not `k`) and `data` is a bare Memory[]
   * — no `items`, `recall_id` or `reason`, and no page sections. The server
   * scopes a recall to one project plus what the caller was granted; with
   * no `project_id` that project is the personal space.
   */
  async recall(query: string, opts?: { spaceId?: Id; limit?: number }): Promise<RecallHit[]> {
    if (!query.trim()) return [];
    const rows = arr(
      await this.data('POST', '/memories/recall', {
        query: query.trim().slice(0, 2000),
        project_id: opts?.spaceId,
        limit: Math.min(50, opts?.limit ?? 12),
      }),
    );
    return rows.map((m) => {
      const c = toContext(m);
      const project = obj(m['project']);
      return {
        id: c.id,
        type: 'context' as const,
        title: c.statement,
        meta: [c.author, str(project['name'])].filter(Boolean).join(' · '),
        kind: c.kind,
        href: c.sessionId ? `/sessions/${c.sessionId}/context` : `/spaces/${c.spaceId}`,
      };
    });
  }

  // ── no endpoint yet: sample data, flagged in `preview` ────────────────

  listPages = async () => []; // a real space has no sample pages to show
  getPage = (id: Id) => this.fallback.getPage(id);
  listAccessDefaults = () => this.fallback.listAccessDefaults();
  listConnectors = () => this.fallback.listConnectors();
  updateConnector: OpenKTClient['updateConnector'] = (id, patch) => this.fallback.updateConnector(id, patch);
  listSkills = () => this.fallback.listSkills();
  createSkill = (name: string) => this.fallback.createSkill(name);
  runSkill = (id: Id) => this.fallback.runSkill(id);
  getModelSettings = () => this.fallback.getModelSettings(); // local to the Mac, never a server call
  setModel: OpenKTClient['setModel'] = (job, name) => this.fallback.setModel(job, name);
  setModelEndpoint = (endpoint: string) => this.fallback.setModelEndpoint(endpoint);
}
