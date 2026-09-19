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
 *   GET    /v1/projects · /v1/projects/:id {id, slug, name, visibility, org_id, owner_user_id, …} — owned and granted; by id adds viewer_role
 *   POST   /v1/projects                    {name, slug} → a new private space, shared through its grants (slug: lowercase kebab, 2–41;
 *                                           taken → 400 "slug already exists", or 409)
 *   GET    /v1/orgs · /v1/orgs/slug/:slug/members   people for the invite field
 *   GET    /v1/sessions?project_id=        one project per call; none → the personal space
 *   POST   /v1/sessions                    {project_id, source, client, title}
 *   POST   /v1/sessions/:id/turns          ONE turn per call: {role, content}
 *   POST   /v1/sessions/:id/close          {summary}
 *   GET    /v1/sessions/:id                {session, turns, memories}
 *   POST   /v1/memories                    {content, kind, project_id, session_id}
 *   DELETE /v1/memories/:id
 *   POST   /v1/memories/recall             {query, project_id?, limit} → data: Memory[] (with `similarity`);
 *                                           none → personal + the caller's other private spaces, so a shared
 *                                           space is asked by name and the answers are merged
 *   POST   /v1/memories/search             {query, mode, filters:{project_ids}, limit} → Memory[] across every listed space (all must be readable)
 *   GET    /v1/{sessions|projects}/:id/grants          owner only → rows with `subject:{id,email,display_name}` or `{pending:true,email}`
 *   PUT    /v1/{sessions|projects}/:id/grants          {email, role} → the grant, or `{pending:true}` when that person has no account yet
 *   DELETE /v1/{sessions|projects}/:id/grants/:userId  (or the pending share's own id)
 *   GET    /v1/skills?project_id=&q=       [{id, slug, title, description, project_id, space_name, owner, current_version, updated_at, run_count_30d, my_role}]
 *   POST   /v1/skills                      {title, project_id?, files?} → v1 (the server writes a starter SKILL.md)
 *   GET    /v1/skills/:id                  skill + files:[{path,content,bytes}] + versions:[{version,change_note,created_by,created_at}]
 *   GET    /v1/skills/:id/versions/:n      {files}
 *   PUT    /v1/skills/:id                  {files, change_note?, base_version} → new version; 409 version_conflict
 *   POST   /v1/skills/:id/versions/:n/restore · PATCH /v1/skills/:id {project_id?|archived?} · DELETE /v1/skills/:id
 *   GET|PUT /v1/skills/:id/grants          as above; DELETE /v1/skills/:id/grants/:userId (or the pending share's id), as above
 *   POST   /v1/skills/:id/runs             {surface:'app'} → records a run, returns the current files
 *   Behind `capabilities()` (probed; a missing route hides the control):
 *   PATCH  /v1/sessions/:id                {project_id} → the session, moved (no server has it yet)
 *   POST   /v1/projects/:id/join-links     {role} → {code, url, space_id, role, expires_at, …} (owner or editor)
 *   POST   /v1/join                        {code} → {space: {id, name}, role}; 404 for a link that is unknown, expired or used up
 *   GET    /v1/projects/:id/pages · GET /v1/pages/:id · PUT /v1/pages/:id/sections/:sid · GET /v1/projects/:id/brief
 *   (signing in and out: src/api/auth.ts)
 *
 * The server says project and memory; the app says space and context. Those
 * words stop at this file. Connectors, access defaults, teams and models
 * have no endpoint: they come from the local mock and are listed in
 * `preview` so their screens carry a "sample data" badge.
 */
import type { NetRequest, NetResponse } from '../shared/ipc';
import { netRequest } from './bridge';
import { NotFoundError, type OpenKTClient } from './client';
import { ApiError, kindForStatus } from './errors';
import { relativeDay, sourceLabel } from './format';
import { MockClient } from './mock';
import { toBrief, toPage, toPageListItem, toProcessing } from './pages';
import { createDeviceSeed } from './mock/seed';
import { byteLength } from './skillFiles';
import { isSlugTaken, joinCodeFrom, localDescription, nextFreeSlug, setLocalDescription, spaceSlug } from './spaces';
import type {
  Capabilities,
  ContextItem,
  ContextKind,
  Grant,
  GrantSubject,
  Id,
  JoinLink,
  Me,
  NewFactInput,
  NewSessionInput,
  NewSkillInput,
  NewSpaceInput,
  Page,
  PageListItem,
  PreviewArea,
  RecallHit,
  ResourceRef,
  Role,
  SaveSkillInput,
  Session,
  SessionListItem,
  SessionSource,
  Skill,
  SkillFile,
  SkillSummary,
  Space,
  SpaceBrief,
  SpaceMember,
  SpaceMembers,
  SpaceProcessing,
  Workspace,
} from './types';

/** Transport failures that say "try again", not "the server is not there". */
const TRANSIENT = /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_HTTP2_|ECONNRESET/;
/** Back-off before each retry of a read, in ms. */
const RETRIES = [250, 750];

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
    .map((w) => /[\p{L}\p{N}]/u.exec(w)?.[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

const APP_SOURCES: readonly SessionSource[] = ['meeting', 'claude-code', 'codex', 'cursor', 'chatgpt', 'claude', 'hermes', 'voice', 'screenshot', 'note'];

/** SPEC-04: the server's sources add `mcp` and `connector`; `client` disambiguates anything else. */
function toSource(source: string, client: string): SessionSource {
  if ((APP_SOURCES as readonly string[]).includes(source)) return source as SessionSource;
  const hint = APP_SOURCES.find((s) => client.toLowerCase().includes(s));
  return hint ?? (source === 'mcp' ? 'claude-code' : 'note');
}

// The server's session sources (server SESSION_SOURCES) that the app has words for; anything else goes as `connector`.
const SERVER_SOURCES = new Set(['claude-code', 'codex', 'cursor', 'chatgpt', 'claude', 'hermes', 'mcp', 'voice', 'meeting', 'screenshot', 'note', 'connector']);
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

function toSession(j: Json, turns: Json[] = [], authorName = ''): Session {
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
    authorName,
    createdAt: startedAt,
    durationSec: endedAt && (source === 'meeting' || source === 'voice') ? Math.max(0, Math.round((Date.parse(endedAt) - start) / 1000)) : undefined,
    extractedOn: ((on) => (on === 'device' || on === 'none' ? on : 'server'))(str(obj(j['metadata'])['extracted_on'])),
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
    authorId: str(owner['user_id'] ?? owner['id']) || undefined,
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

/** `viewer_role` on a project → what the app lets the person do. Sharing is the literal owner's alone, so a grant "owner" (`admin`) edits. */
function roleFromViewer(v: unknown): Role | undefined {
  if (v === 'owner') return 'owner';
  if (v === 'admin' || v === 'member') return 'editor';
  if (v === 'viewer') return 'reader';
  return undefined;
}

/** A route the server does not have: Nest answers 404 "Cannot PATCH /v1/…" (code `http_exception`), unlike a 404 for a missing thing. */
const missingRoute = (e: ApiError): boolean => e.status === 405 || (e.status === 404 && (e.code === 'http_exception' || /^Cannot [A-Z]+ \//.test(e.message)));

const NIL_UUID = '00000000-0000-4000-8000-000000000000';

export class HttpClient implements OpenKTClient {
  readonly kind = 'http' as const;
  readonly preview: ReadonlySet<PreviewArea> = new Set<PreviewArea>(['connectors', 'access-defaults', 'models', 'teams']);
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch | null;
  private readonly onUnauthorized?: () => void;
  /** Settings kept on this Mac (connectors, models). Never the sample workspace: no spaces, sessions, pages or skills. */
  private readonly fallback = new MockClient(createDeviceSeed());
  private listeners = new Set<() => void>();
  private me?: Promise<Me>;
  private members?: Promise<Member[]>;
  private personalId?: Promise<Id>;
  private caps?: Promise<Capabilities>;
  /** Names for user ids, learned from everything that carries one (grants, facts, skills, org members). Sessions carry only an id. */
  private people = new Map<Id, { name: string; email?: string }>();
  /** Each space's author lookup, so a list of sessions does not refetch them on every render. */
  private learning = new Map<Id, { at: number; done: Promise<void> }>();

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
    this.searchCache = undefined;
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
    let res: NetResponse | undefined;
    for (let attempt = 0; !res; attempt++) {
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
        const message = e instanceof Error ? e.message : String(e);
        // Chromium drops requests in flight when the network flips (wake from sleep, Wi-Fi/VPN change, and
        // on some machines right at launch). A read is safe to send again; a write is not, it may have landed.
        if (method === 'GET' && attempt < RETRIES.length && TRANSIENT.test(message)) {
          await new Promise((r) => setTimeout(r, RETRIES[attempt]));
          continue;
        }
        throw new ApiError('network', message, 0, '', path);
      }
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

  private learn(id: unknown, name: unknown, email?: unknown): void {
    const key = str(id);
    const n = str(name) || str(email);
    if (key && n) this.people.set(key, { name: n, email: str(email) || this.people.get(key)?.email });
  }

  private nameOf(id: Id): string {
    return this.people.get(id)?.name ?? '';
  }

  getMe(): Promise<Me> {
    this.me ??= this.data('GET', '/me').then((d) => {
      const j = obj(d);
      const email = str(j['email']);
      const name = str(pick(j, 'display_name'), email || 'You');
      const me = { id: str(pick(j, 'user_id')), name, email, initials: initialsOf(name) };
      this.learn(me.id, me.name, me.email);
      return me;
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
        if (id && !seen.has(id)) {
          seen.set(id, {
            id,
            email,
            name: str(pick(m, 'display_name'), email || id.slice(0, 8)),
          });
          this.learn(id, pick(m, 'display_name'), email);
        }
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

  // ── capabilities ──────────────────────────────────────────────────────

  /**
   * Asks each optional route something harmless: a nil session id to PATCH, an
   * empty join code. A server that has the route answers 400/404-not-found;
   * one that does not answers Nest's "Cannot PATCH …". Asked once per client;
   * a network failure is not remembered, so the next screen asks again.
   */
  capabilities(): Promise<Capabilities> {
    this.caps ??= Promise.all([this.hasRoute('PATCH', `/sessions/${NIL_UUID}`, {}), this.hasRoute('POST', '/join', { code: '' })]).then(([moveSession, joinLinks]) => ({ moveSession, joinLinks }));
    this.caps.catch(() => (this.caps = undefined));
    return this.caps;
  }

  private async hasRoute(method: NetRequest['method'], path: string, body: unknown): Promise<boolean> {
    try {
      await this.call(method, path, body);
      return true;
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind === 'network') throw e;
      return !missingRoute(e);
    }
  }

  // ── spaces ────────────────────────────────────────────────────────────

  /**
   * The personal space. `GET /v1/projects/personal` creates it on first use, but once the person owns a
   * second private project (every space made with "New space") the server answers with whichever of them
   * Postgres returns first (project-scope.service.ts resolvePersonalProjectId: `.limit(1)`, no ORDER BY) —
   * notes were filed into a shared space that way. So it is the oldest owned project with the slug
   * `personal`, and the server's answer only when there is none.
   */
  private personal(): Promise<Id> {
    this.personalId ??= (async () => {
      const [fromServer, me, projects] = await Promise.all([this.data('GET', '/projects/personal'), this.getMe(), this.data('GET', '/projects').then(arr)]);
      const own = projects
        .filter((p) => str(p['slug']) === 'personal' && str(pick(p, 'owner_user_id')) === me.id && !pick(p, 'org_id'))
        .sort((a, b) => str(pick(a, 'created_at')).localeCompare(str(pick(b, 'created_at'))));
      return str(own[0]?.['id']) || str(obj(fromServer)['id']);
    })();
    this.personalId.catch(() => (this.personalId = undefined));
    return this.personalId;
  }

  private toSpace(j: Json, personalId: Id, meId: Id, extra: { sessionCount?: number; memberCount?: number; myRole?: Role } = {}): Space {
    const id = str(j['id']);
    const personal = id === personalId;
    const ownerId = str(pick(j, 'owner_user_id'));
    return {
      id,
      name: personal ? 'Personal' : str(j['name'], str(j['slug'])),
      slug: personal ? 'personal' : str(j['slug']),
      description: personal ? 'Only you can see this space.' : str(j['description']) || localDescription(id),
      personal,
      memberCount: personal ? 1 : (extra.memberCount ?? 0),
      pageCount: 0,
      sessionCount: extra.sessionCount ?? 0,
      updatedAt: str(pick(j, 'updated_at'), new Date().toISOString()),
      ownerId: ownerId || undefined,
      myRole: personal || (ownerId && ownerId === meId) ? 'owner' : (roleFromViewer(pick(j, 'viewer_role')) ?? extra.myRole),
    };
  }

  /** People with access to a space the caller owns: the owner plus everyone whose share has been taken up. Unknown (0) otherwise. */
  private async memberCount(id: Id): Promise<number> {
    const rows = arr(await this.data('GET', `/projects/${encodeURIComponent(id)}/grants`));
    for (const g of rows) this.learnGrant(g);
    return 1 + rows.filter((g) => g['pending'] !== true && obj(g['subject'])['pending'] !== true).length;
  }

  private sessionTotal(id: Id): Promise<number> {
    // The list has no counts; `meta.total` of a one-row session list is the cheapest honest number.
    return this.call('GET', `/sessions?project_id=${encodeURIComponent(id)}&limit=1`).then(
      (r) => Number(r.meta['total'] ?? 0),
      () => 0,
    );
  }

  async listSpaces(): Promise<Space[]> {
    const [personalId, me, projects] = await Promise.all([this.personal(), this.getMe(), this.data('GET', '/projects').then(arr)]);
    const spaces = await Promise.all(
      projects.map(async (p) => {
        const id = str(p['id']);
        const owned = str(pick(p, 'owner_user_id')) === me.id;
        const [sessionCount, extra] = await Promise.all([
          this.sessionTotal(id),
          id === personalId
            ? {}
            : owned
              ? this.memberCount(id).then((memberCount) => ({ memberCount }), () => ({}))
              : // Shared with me: the list does not say how; the project itself does.
                this.data('GET', `/projects/${encodeURIComponent(id)}`).then((d) => ({ myRole: roleFromViewer(obj(d)['viewer_role']) }), () => ({})),
        ]);
        return this.toSpace(p, personalId, me.id, { sessionCount, ...extra });
      }),
    );
    return spaces.sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));
  }

  async getSpace(id: Id): Promise<Space> {
    const [personalId, me, project, sessionCount] = await Promise.all([this.personal(), this.getMe(), this.data('GET', `/projects/${encodeURIComponent(id)}`), this.sessionTotal(id)]);
    const j = obj(project);
    const owned = str(pick(j, 'owner_user_id')) === me.id && id !== personalId;
    const memberCount = owned ? await this.memberCount(id).catch(() => 0) : undefined;
    return this.toSpace(j, personalId, me.id, { sessionCount, memberCount });
  }

  /**
   * The slug comes from the name. Taken slugs are skipped before asking (the
   * spaces this person can see), and a 409 — or today's 400 "slug already
   * exists" — moves on to the next suffix.
   */
  async createSpace(input: NewSpaceInput): Promise<Space> {
    const name = input.name.trim().slice(0, 120);
    if (!name) throw new ApiError('invalid', 'Give the space a name.', 400, 'validation_error', '/projects');
    const [personalId, me, projects] = await Promise.all([this.personal(), this.getMe(), this.data('GET', '/projects').then(arr, () => [] as Json[])]);
    // `personal` is how the personal space is found: never make another.
    const taken = new Set(['personal', ...projects.map((p) => str(p['slug']))]);
    const base = spaceSlug(name);
    let n = 1;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const next = nextFreeSlug(base, taken, n);
      n = next.n + 1;
      let created: Json;
      try {
        created = obj(await this.data('POST', '/projects', { name, slug: next.slug }));
      } catch (e) {
        if (isSlugTaken(e)) {
          taken.add(next.slug);
          continue;
        }
        throw e;
      }
      const id = str(created['id']);
      if (input.description?.trim()) setLocalDescription(id, input.description);
      this.changed();
      return { ...this.toSpace(created, personalId, me.id, { memberCount: 1, sessionCount: 0 }), description: input.description?.trim() ?? '' };
    }
    throw new ApiError('conflict', 'Every name close to that one is taken. Try another name.', 409, 'slug_taken', '/projects');
  }

  private learnGrant(g: Json): void {
    const subject = obj(g['subject']);
    if (subject['pending'] === true || g['pending'] === true) return;
    this.learn(subject['id'] ?? pick(g, 'subject_id'), pick(subject, 'display_name'), subject['email']);
  }

  /** The newest facts in a space, through search (a teammate may not list a space's memories directly, but may search it). */
  private async spaceFacts(spaceId: Id, limit = 100): Promise<ContextItem[]> {
    const rows = arr(
      await this.data('POST', '/memories/search', {
        query: '',
        mode: 'keyword',
        filters: { project_ids: [spaceId] },
        limit: Math.min(100, Math.max(1, limit)),
      }),
    );
    return rows
      .filter((m) => str(m['project_id']) === spaceId && m['archived'] !== true)
      .map((m) => this.context(m))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private context(m: Json): ContextItem {
    const c = toContext(m);
    const owner = obj(m['owner']);
    this.learn(c.authorId, owner['display_name'], owner['email']);
    return c;
  }

  /**
   * Put names to the people who saved things in a space: its facts' authors,
   * and — for its owner — everyone it is shared with. One lookup per space
   * every 30 seconds; callers in the meantime wait for the same one.
   */
  private learnSpace(spaceId: Id): Promise<void> {
    const last = this.learning.get(spaceId);
    if (last && Date.now() - last.at < 30_000) return last.done;
    const done = Promise.all([
      this.spaceFacts(spaceId).catch(() => []),
      this.data('GET', `/projects/${encodeURIComponent(spaceId)}/grants`).then(
        (rows) => arr(rows).forEach((g) => this.learnGrant(g)),
        () => undefined,
      ),
    ]).then(() => undefined);
    this.learning.set(spaceId, { at: Date.now(), done });
    return done;
  }

  async listSpaceContext(spaceId: Id, opts?: { limit?: number }): Promise<ContextItem[]> {
    return (await this.spaceFacts(spaceId)).slice(0, opts?.limit ?? 20);
  }

  /**
   * The owner gets the whole list from the grants. Anyone else may not list
   * grants, so they see themselves, the owner and whoever has saved something
   * there — and `complete: false` says that is not everyone.
   */
  async listSpaceMembers(spaceId: Id): Promise<SpaceMembers> {
    const [me, space] = await Promise.all([this.getMe(), this.getSpace(spaceId)]);
    if (space.myRole === 'owner') {
      const grants = await this.listGrants({ type: 'space', id: spaceId });
      const members: SpaceMember[] = grants.map((g) => ({
        id: g.subject.id,
        name: g.subject.name,
        initials: g.pending ? initialsOf(g.subject.name) : g.subject.initials,
        email: g.subject.email,
        role: g.role,
        pending: g.pending || undefined,
        you: g.subject.id === me.id || undefined,
      }));
      if (!members.some((m) => m.you)) members.unshift({ id: me.id, name: me.name, initials: me.initials, email: me.email, role: 'owner', you: true });
      return { members, complete: true };
    }
    const [facts] = await Promise.all([this.spaceFacts(spaceId).catch(() => [] as ContextItem[]), this.learnSpace(spaceId)]);
    const members: SpaceMember[] = [];
    const ownerId = space.ownerId ?? '';
    if (ownerId && ownerId !== me.id) {
      const name = this.nameOf(ownerId) || 'The owner';
      members.push({ id: ownerId, name, initials: initialsOf(name), email: this.people.get(ownerId)?.email, role: 'owner' });
    }
    members.push({ id: me.id, name: me.name, initials: me.initials, email: me.email, role: space.myRole, you: true });
    for (const f of facts) {
      if (!f.authorId || members.some((m) => m.id === f.authorId)) continue;
      const name = this.nameOf(f.authorId) || f.author;
      members.push({ id: f.authorId, name, initials: initialsOf(name), email: this.people.get(f.authorId)?.email });
    }
    return { members, complete: false };
  }

  async createJoinLink(spaceId: Id, role: Role): Promise<JoinLink> {
    const j = obj(await this.data('POST', `/projects/${encodeURIComponent(spaceId)}/join-links`, { role }));
    const code = str(j['code']);
    return { code, url: str(j['url'], code), role: (['reader', 'editor', 'owner'] as const).find((r) => r === j['role']) ?? role };
  }

  async joinSpace(linkOrCode: string): Promise<Space> {
    const code = joinCodeFrom(linkOrCode);
    if (!code) throw new ApiError('invalid', 'Paste the whole invite link, or the code from it.', 400, 'validation_error', '/join');
    const j = obj(await this.data('POST', '/join', { code }));
    // `{space: {id, name}, role}` (modules/teams); older shapes said `project_id`.
    const id = str(obj(j['space'])['id']) || str(pick(j, 'project_id')) || str(obj(j['project'])['id']);
    this.changed();
    return this.getSpace(id);
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
    const [lists, me] = await Promise.all([Promise.all(ids.map((id) => this.data('GET', `/sessions?project_id=${encodeURIComponent(id)}&limit=100`).then(arr, () => []))), this.getMe()]);
    const rows = lists.flat();
    // Sessions carry only the author's id: put names to the ones this client has not met yet.
    const strangers = new Set(rows.filter((j) => !this.people.has(str(j['owner_user_id']))).map((j) => str(j['project_id'])));
    if (!filter?.mine) await Promise.all([...strangers].map((p) => this.learnSpace(p)));
    return rows
      .map((j) => {
        const { turns: _t, ...rest } = toSession(j, [], this.nameOf(str(j['owner_user_id'])));
        return rest;
      })
      .filter((s) => (filter?.mine ? s.authorId === me.id : true))
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
    const [{ session, turns, memories }] = await Promise.all([this.sessionPayload(id), this.getMe()]);
    for (const m of memories) this.context(m);
    const authorId = str(session['owner_user_id']);
    if (!this.people.has(authorId)) await this.learnSpace(str(session['project_id']));
    return toSession(session, turns, this.nameOf(authorId));
  }

  async listContext(sessionId: Id): Promise<ContextItem[]> {
    const { memories } = await this.sessionPayload(sessionId);
    return memories.filter((m) => m['archived'] !== true).map((m) => this.context(m));
  }

  /** Needs `PATCH /v1/sessions/:id` (see `capabilities`); a server without it answers a typed not-found. */
  async moveSession(id: Id, spaceId: Id): Promise<Session> {
    const j = obj(await this.data('PATCH', `/sessions/${encodeURIComponent(id)}`, { project_id: spaceId }));
    this.changed();
    const session = obj(j['session'])['id'] ? obj(j['session']) : j;
    return toSession(session, [], this.nameOf(str(session['owner_user_id'])));
  }

  async createSession(input: NewSessionInput): Promise<Session> {
    const j = obj(
      await this.data('POST', '/sessions', {
        project_id: input.spaceId || (await this.personal()),
        source: fromSource(input.source),
        client: 'openkt-desktop',
        title: input.title.trim().slice(0, 200) || null,
        metadata: { extracted_on: input.extractedOn ?? 'device' },
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
    return toSession(j, turns, (await this.getMe()).name);
  }

  async closeSession(id: Id, summary?: string): Promise<Session> {
    const j = obj(
      await this.data('POST', `/sessions/${encodeURIComponent(id)}/close`, {
        summary: summary?.trim() || null,
      }),
    );
    this.changed();
    return toSession(j, [], this.nameOf(str(j['owner_user_id'])));
  }

  /** SPEC-04: there is no `POST /v1/sessions/:id/facts`; a fact is a memory created with `session_id`. */
  async saveFact(input: NewFactInput): Promise<ContextItem> {
    const kind = input.kind ?? 'fact';
    const m = obj(
      await this.data('POST', '/memories', {
        content: input.statement.trim(),
        kind: fromKind(kind),
        category: kind,
        project_id: input.spaceId || (await this.personal()),
        session_id: input.sessionId,
        visibility: 'project',
      }),
    );
    this.changed();
    return {
      ...this.context({
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
    const segment = resource.type === 'space' ? 'projects' : resource.type === 'skill' ? 'skills' : 'sessions';
    return `/${segment}/${encodeURIComponent(resource.id)}/grants`;
  }

  /**
   * A grant row names its person: `subject:{id,email,display_name}`. A share
   * with someone who has no account yet is `{id, pending:true, email, role}`
   * (the email may also sit under `subject`); its own `id` is what withdraws it.
   * Older servers sent a bare `subject_id`; the name is then joined from the
   * org member list. A raw id is never shown.
   */
  private toGrant(g: Json, resource: ResourceRef, me: Me, members: Member[]): Grant {
    const subject = obj(g['subject']);
    const role = (['reader', 'editor', 'owner'] as const).find((r) => r === g['role']) ?? 'reader';
    const addedByMe = str(pick(g, 'created_by')) === me.id;
    const email = str(subject['email']) || str(g['email']);
    if (subject['pending'] === true || g['pending'] === true) {
      return {
        id: str(g['id'], `${resource.id}:invited:${email}`),
        resource,
        subject: { type: 'user', id: `invited:${str(g['id'], email)}`, name: email, initials: initialsOf(email), email },
        role,
        note: addedByMe ? 'added by you' : '',
        pending: true,
      };
    }
    const id = str(subject['id']) || str(pick(g, 'subject_id'));
    this.learnGrant(g);
    const known = id === me.id ? me : members.find((x) => x.id === id);
    const mail = email || known?.email || '';
    const name = str(pick(subject, 'display_name')) || known?.name || mail || 'Teammate';
    return {
      id: str(g['id'], `${resource.id}:${id}`),
      resource,
      subject: { type: 'user', id, name, initials: initialsOf(name), email: mail || undefined },
      role,
      note: id === me.id ? 'you' : addedByMe ? 'added by you' : '',
    };
  }

  /** Listing is owner-only: a 403/404 means "not yours to manage" and reads as an empty list rather than an error. */
  async listGrants(resource: ResourceRef): Promise<Grant[]> {
    let rows: Json[];
    try {
      rows = arr(await this.data('GET', this.grantsPath(resource)));
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'forbidden' || e.kind === 'not-found')) return [];
      throw e;
    }
    const [me, members, ownerId] = await Promise.all([this.getMe(), this.listMembers().catch(() => [] as Member[]), this.ownerOf(resource).catch(() => '')]);
    const grants = rows.map((g) => this.toGrant(g, resource, me, members));
    // The owner holds no grant row on the server (ownership is a column), but the Access tab must show them.
    if (ownerId && !grants.some((g) => g.subject.id === ownerId)) {
      const m = ownerId === me.id ? me : members.find((x) => x.id === ownerId);
      const name = m?.name ?? 'Owner';
      grants.unshift({
        id: `${resource.id}:owner`,
        resource,
        subject: { type: 'user', id: ownerId, name, initials: initialsOf(name), email: m?.email || undefined },
        role: 'owner',
        note: `${ownerId === me.id ? 'you · ' : ''}${resource.type === 'skill' ? 'wrote' : 'created'} this ${resource.type}`,
        inherited: true,
      });
    }
    return grants;
  }

  private async ownerOf(resource: ResourceRef): Promise<Id> {
    if (resource.type === 'space') return str(pick(obj(await this.data('GET', `/projects/${encodeURIComponent(resource.id)}`)), 'owner_user_id'));
    if (resource.type === 'skill') return (await this.getSkill(resource.id)).owner.id;
    return str((await this.sessionPayload(resource.id)).session['owner_user_id']);
  }

  async inviteByEmail(resource: ResourceRef, email: string, role: Role): Promise<Grant> {
    const address = email.trim();
    const g = obj(await this.data('PUT', this.grantsPath(resource), { email: address, role }));
    this.changed();
    const [me, members] = await Promise.all([this.getMe(), this.listMembers().catch(() => [] as Member[])]);
    // `{pending:true}` may be the whole answer; the email and role are the ones just sent.
    return { ...this.toGrant({ email: address, role, created_by: me.id, ...g }, resource, me, members), role };
  }

  /** By email when the row has one (the documented call); by id against a server that predates it. */
  async putGrant(resource: ResourceRef, subject: GrantSubject, role: Role): Promise<Grant> {
    if (subject.email) return { ...(await this.inviteByEmail(resource, subject.email, role)), subject };
    const g = obj(await this.data('PUT', `${this.grantsPath(resource)}/${encodeURIComponent(subject.id)}`, { role }));
    this.changed();
    return { id: str(g['id'], `${resource.id}:${subject.id}`), resource, subject, role, note: 'added by you' };
  }

  /** The path names a user id for a real grant, or the pending share's own id for one still waiting on a sign-up. */
  async deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id' | 'email'>): Promise<void> {
    const key = subject.id.startsWith('invited:') ? subject.id.slice('invited:'.length) : subject.id;
    await this.data('DELETE', `${this.grantsPath(resource)}/${encodeURIComponent(key)}`);
    this.changed();
  }

  // ── skills ────────────────────────────────────────────────────────────

  private toSkillSummary(j: Json): SkillSummary {
    const owner = obj(j['owner']);
    const ownerName = str(pick(owner, 'display_name'), str(owner['email'], 'Owner'));
    this.learn(owner['id'] ?? pick(owner, 'user_id'), pick(owner, 'display_name'), owner['email']);
    return {
      id: str(j['id']),
      slug: str(j['slug']),
      title: str(j['title'], 'Untitled skill'),
      description: str(j['description']),
      spaceId: str(pick(j, 'project_id')),
      spaceName: str(pick(j, 'space_name')),
      owner: { id: str(owner['id'] ?? pick(owner, 'user_id')), name: ownerName },
      currentVersion: Number(pick(j, 'current_version') ?? 1) || 1,
      updatedAt: str(pick(j, 'updated_at'), new Date().toISOString()),
      runCount30d: Number(pick(j, 'run_count_30d') ?? 0) || 0,
      myRole: (['owner', 'editor', 'reader'] as const).find((r) => r === pick(j, 'my_role')) ?? 'reader',
    };
  }

  private toSkillFiles(v: unknown): SkillFile[] {
    return arr(v).map((f) => {
      const content = typeof f['content'] === 'string' ? f['content'] : '';
      return { path: str(f['path']), content, bytes: Number(f['bytes'] ?? NaN) || byteLength(content) };
    });
  }

  private toSkill(d: unknown): Skill {
    // The detail may arrive flat, or as `{skill, files, versions}` like a session does.
    const j = obj(d);
    const head = obj(j['skill'])['id'] ? { ...obj(j['skill']), ...j } : j;
    return {
      ...this.toSkillSummary(head),
      files: this.toSkillFiles(j['files']),
      versions: arr(j['versions'])
        .map((v) => {
          const by = obj(pick(v, 'created_by'));
          return {
            version: Number(v['version']) || 1,
            changeNote: str(pick(v, 'change_note')),
            createdBy: { id: str(by['id'] ?? pick(by, 'user_id')), name: str(pick(by, 'display_name'), str(by['email'], 'Someone')) },
            createdAt: str(pick(v, 'created_at'), new Date().toISOString()),
          };
        })
        .sort((a, b) => b.version - a.version),
    };
  }

  /** A write may answer with the whole skill or just its new head; either way the caller gets it opened. */
  private async opened(d: unknown, id?: Id): Promise<Skill> {
    const skill = this.toSkill(d);
    return skill.files.length && skill.versions.length ? skill : this.getSkill(id ?? skill.id);
  }

  async listSkills(filter?: { spaceId?: Id; q?: string }): Promise<SkillSummary[]> {
    const query = new URLSearchParams();
    if (filter?.spaceId) query.set('project_id', filter.spaceId);
    if (filter?.q?.trim()) query.set('q', filter.q.trim());
    const qs = query.toString();
    return arr(await this.data('GET', `/skills${qs ? `?${qs}` : ''}`)).map((j) => this.toSkillSummary(j));
  }

  async getSkill(id: Id): Promise<Skill> {
    return this.toSkill(await this.data('GET', `/skills/${encodeURIComponent(id)}`));
  }

  async getSkillVersion(id: Id, version: number): Promise<SkillFile[]> {
    return this.toSkillFiles(obj(await this.data('GET', `/skills/${encodeURIComponent(id)}/versions/${version}`))['files']);
  }

  async createSkill(input: NewSkillInput): Promise<Skill> {
    const d = await this.data('POST', '/skills', { title: input.title.trim(), project_id: input.spaceId || undefined, files: input.files?.length ? input.files : undefined });
    this.changed();
    return this.opened(d);
  }

  async saveSkill(id: Id, input: SaveSkillInput): Promise<Skill> {
    const d = await this.data('PUT', `/skills/${encodeURIComponent(id)}`, {
      files: input.files.map(({ path, content }) => ({ path, content })),
      change_note: input.changeNote?.trim() || undefined,
      base_version: input.baseVersion,
    });
    this.changed();
    return this.opened(d, id);
  }

  async restoreSkillVersion(id: Id, version: number): Promise<Skill> {
    const d = await this.data('POST', `/skills/${encodeURIComponent(id)}/versions/${version}/restore`, {});
    this.changed();
    return this.opened(d, id);
  }

  async updateSkill(id: Id, patch: { spaceId?: Id; archived?: boolean }): Promise<SkillSummary> {
    const j = obj(await this.data('PATCH', `/skills/${encodeURIComponent(id)}`, { project_id: patch.spaceId, archived: patch.archived }));
    this.changed();
    return this.toSkillSummary(obj(j['skill'])['id'] ? obj(j['skill']) : j);
  }

  async deleteSkill(id: Id): Promise<void> {
    await this.data('DELETE', `/skills/${encodeURIComponent(id)}`);
    this.changed();
  }

  async recordSkillRun(id: Id): Promise<SkillFile[]> {
    const files = this.toSkillFiles(obj(await this.data('POST', `/skills/${encodeURIComponent(id)}/runs`, { surface: 'app' }))['files']);
    this.changed();
    return files;
  }

  // ── recall ────────────────────────────────────────────────────────────

  /**
   * Scoped to a space: `POST /v1/memories/recall` with its `project_id`
   * (SPEC-04: the body takes `limit`, not `k`, and `data` is a bare Memory[] —
   * no `items`, `recall_id` or `reason`, and no page sections).
   * Everything (⌘K): `POST /v1/memories/search` over every space the person
   * can read — recall alone would stop at their own spaces and never reach
   * one a teammate shared with them. Each hit says who saved it and where.
   */
  async recall(query: string, opts?: { spaceId?: Id; limit?: number }): Promise<RecallHit[]> {
    const q = query.trim();
    if (!q) return [];
    const limit = Math.min(50, opts?.limit ?? 12);
    const ask = (projectId: Id) => this.data('POST', '/memories/recall', { query: q.slice(0, 2000), project_id: projectId, limit }).then(arr);
    // Recall with no project_id covers the personal space and the caller's other private spaces.
    // A space shared with the caller (or an org space) is only searched when named, so "everything
    // you can read" asks each of those too. The first call's failure is the palette's error.
    const [first, ...rest] = await Promise.all([
      ask(opts?.spaceId || (await this.personal())),
      ...(opts?.spaceId ? [] : (await this.sharedSpaceIds().catch(() => [] as Id[])).map((id) => ask(id).catch(() => [] as Json[]))),
    ]);
    const seen = new Set<string>();
    const rows = [first ?? [], ...rest]
      .flat()
      .filter((m) => !seen.has(str(m['id'])) && seen.add(str(m['id'])))
      .sort((a, b) => Number(b['similarity'] ?? 0) - Number(a['similarity'] ?? 0))
      .slice(0, limit);
    // Name each hit's space the way the app does (the personal space is "Personal").
    const names = new Map((await this.listSpaceIds().catch(() => [])).map((sp) => [sp.id, sp.name]));
    const context = rows.map((m) => {
      const c = this.context(m);
      const spaceName = names.get(c.spaceId) || str(obj(m['project'])['name']);
      return {
        id: c.id,
        type: 'context' as const,
        title: c.statement,
        meta: [c.author, spaceName].filter(Boolean).join(' · '),
        kind: c.kind,
        author: c.author,
        spaceName,
        href: c.sessionId ? `/sessions/${c.sessionId}/context` : `/spaces/${c.spaceId}`,
      };
    });
    // The server searches context, not titles; a session is also found by its name (as the sample adapter does).
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const sessions = (await this.sessionsForSearch(opts?.spaceId).catch(() => [] as SessionListItem[]))
      .filter((s) => words.every((w) => s.title.toLowerCase().includes(w)))
      .slice(0, 5)
      .map((s) => ({
        id: s.id,
        type: 'session' as const,
        title: s.title,
        meta: `${sourceLabel(s.source)} · ${relativeDay(s.createdAt)}`,
        source: s.source,
        author: s.authorName || undefined,
        spaceName: names.get(s.spaceId),
        href: `/sessions/${s.id}`,
      }));
    return [...sessions, ...context];
  }

  /** Spaces the caller can read that a plain recall does not cover: anything not their own private space. */
  private async sharedSpaceIds(): Promise<Id[]> {
    const [me, projects] = await Promise.all([this.getMe(), this.data('GET', '/projects').then(arr)]);
    return projects
      .filter((p) => !(str(pick(p, 'owner_user_id')) === me.id && str(p['visibility']) === 'personal' && !pick(p, 'org_id')))
      .map((p) => str(p['id']))
      .filter(Boolean);
  }

  /** Session titles for ⌘K, kept for a few seconds so typing does not re-list every space per keystroke. */
  private searchCache?: { key: string; at: number; rows: Promise<SessionListItem[]> };
  private sessionsForSearch(spaceId?: Id): Promise<SessionListItem[]> {
    const key = spaceId ?? '*';
    if (!this.searchCache || this.searchCache.key !== key || Date.now() - this.searchCache.at > 15_000) {
      const rows = this.listSessions(spaceId ? { spaceId } : undefined);
      rows.catch(() => (this.searchCache = undefined));
      this.searchCache = { key, at: Date.now(), rows };
    }
    return this.searchCache.rows;
  }

  /** Every space id the person can read, with the name the app shows (the personal space is "Personal"). Cheap: no counts. */
  private async listSpaceIds(): Promise<{ id: Id; name: string }[]> {
    const [personalId, projects] = await Promise.all([this.personal(), this.data('GET', '/projects').then(arr)]);
    const out = projects.map((p) => ({ id: str(p['id']), name: str(p['id']) === personalId ? 'Personal' : str(p['name'], str(p['slug'])) }));
    if (!out.some((s) => s.id === personalId)) out.unshift({ id: personalId, name: 'Personal' });
    return out;
  }

  // ── living pages and the space brief ──────────────────────────────────
  //   GET /v1/projects/:id/pages       → pages; meta.processing = sessions waiting for a Mac
  //   GET /v1/pages/:id                → sections with [^n] markers + sources (who said it, which session)
  //   PUT /v1/pages/:id/sections/:sid  {body_md} → the page again; the section is locked
  //   GET /v1/projects/:id/brief       → {brief_md, updated_at}
  // A server from before living pages answers 404 on these routes: no pages, no brief, nothing waiting.

  async listPages(spaceId: Id): Promise<PageListItem[]> {
    try {
      return arr(await this.data('GET', `/projects/${encodeURIComponent(spaceId)}/pages`)).map(toPageListItem);
    } catch (e) {
      if (e instanceof ApiError && missingRoute(e)) return [];
      throw e;
    }
  }

  async getPage(id: Id): Promise<Page> {
    try {
      return toPage(obj(await this.data('GET', `/pages/${encodeURIComponent(id)}`)));
    } catch (e) {
      if (e instanceof ApiError && missingRoute(e)) throw new NotFoundError('page', id);
      throw e;
    }
  }

  async editPageSection(pageId: Id, sectionId: Id, markdown: string): Promise<Page> {
    const page = toPage(obj(await this.data('PUT', `/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(sectionId)}`, { body_md: markdown })));
    this.changed();
    return page;
  }

  async getSpaceBrief(spaceId: Id): Promise<SpaceBrief | null> {
    try {
      return toBrief(obj(await this.data('GET', `/projects/${encodeURIComponent(spaceId)}/brief`)));
    } catch (e) {
      if (e instanceof ApiError && missingRoute(e)) return null;
      throw e;
    }
  }

  async getSpaceProcessing(spaceId: Id): Promise<SpaceProcessing | null> {
    try {
      return toProcessing((await this.call('GET', `/projects/${encodeURIComponent(spaceId)}/pages`)).meta);
    } catch (e) {
      if (e instanceof ApiError && missingRoute(e)) return null;
      throw e;
    }
  }

  // ── no endpoint yet: sample data, flagged in `preview` ────────────────

  listAccessDefaults = () => this.fallback.listAccessDefaults();
  listConnectors = () => this.fallback.listConnectors();
  updateConnector: OpenKTClient['updateConnector'] = (id, patch) => this.fallback.updateConnector(id, patch);
  getModelSettings = () => this.fallback.getModelSettings(); // local to the Mac, never a server call
  setModel: OpenKTClient['setModel'] = (job, name) => this.fallback.setModel(job, name);
  setModelEndpoint = (endpoint: string) => this.fallback.setModelEndpoint(endpoint);
}
