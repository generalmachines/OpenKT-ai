/**
 * An in-memory OpenKT server for msw. Response shapes are copied from the
 * real server, not invented:
 *   - envelope `{data, error, meta}` and errors `{data:null, error:{code,message,details,request_id}}`
 *     (server/apps/server/src/common/http, common/filters/app-exception.filter.ts)
 *   - SessionRecord / SessionTurnRecord (modules/sessions/contracts/session.contract.ts)
 *   - MemoryRecord incl. owner/project/session_id (modules/memory/contracts/memory.contract.ts)
 *   - GrantRecord, PUT/DELETE …/grants/:userId (modules/grants)
 *   - snake_case profile / project / org member rows, as observed on a live server 2026-09-19
 * Behaviour mirrors what the adapter relies on: one project per session list
 * (none → personal), owner-only grant management, delete = archive, recall
 * scoped to readable projects.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';

type Row = Record<string, unknown>;
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const ok = (data: unknown, meta: unknown = null, status = 200) => HttpResponse.json({ data, error: null, meta }, { status });
const fail = (status: number, code: string, message: string) => HttpResponse.json({ data: null, error: { code, message, details: null, request_id: uuid() }, meta: null }, { status });

export interface FakeUser {
  user_id: string;
  email: string;
  display_name: string;
  token: string;
}

export function createFakeServer(baseUrl: string) {
  const users: FakeUser[] = [
    { user_id: 'e5c5b78e-ba07-5776-86f9-89b0da23bb3f', email: 'pratham@openkt.test', display_name: 'Pratham Bhatnagar', token: 'okt_pat_aaaa' },
    { user_id: 'f72c9558-18db-54a4-860c-6a2f17a79721', email: 'ana@openkt.test', display_name: 'Ana Reyes', token: 'okt_pat_bbbb' },
    { user_id: '0b1f6c1e-52f7-5d0b-9a39-3f7d0c1b2a44', email: 'stranger@elsewhere.test', display_name: 'Sam Stranger', token: 'okt_pat_cccc' },
  ];
  const org = { id: uuid(), slug: 'deepwork', name: 'Deepwork', plan: 'free', members: [users[0]!.user_id, users[1]!.user_id] };
  const projects: Row[] = [];
  const sessions: Row[] = [];
  const turns: Row[] = [];
  const memories: Row[] = [];
  const grants: Row[] = [];

  const project = (owner: FakeUser, slug: string, name: string): Row => {
    const p = { id: uuid(), slug, name, visibility: 'personal', org_id: null, owner_user_id: owner.user_id, created_at: now(), updated_at: now() };
    projects.push(p);
    return p;
  };
  const personalOf = (u: FakeUser) => projects.find((p) => p['owner_user_id'] === u.user_id && p['slug'] === 'personal') ?? project(u, 'personal', 'Personal');
  project(users[0]!, 'northgate', 'Sales / Northgate');

  const auth = (request: Request): FakeUser | null => {
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    return users.find((u) => u.token === token) ?? null;
  };
  const canRead = (u: FakeUser, projectId: unknown) =>
    projects.some((p) => p['id'] === projectId && p['owner_user_id'] === u.user_id) || grants.some((g) => g['resource_type'] === 'project' && g['resource_id'] === projectId && g['subject_id'] === u.user_id);
  const owns = (u: FakeUser, type: string, id: unknown) =>
    type === 'project' ? projects.some((p) => p['id'] === id && p['owner_user_id'] === u.user_id) : sessions.some((s) => s['id'] === id && s['owner_user_id'] === u.user_id);

  const memoryRecord = (m: Row): Row => {
    const owner = users.find((u) => u.user_id === m['owner_user_id'])!;
    const p = projects.find((x) => x['id'] === m['project_id'])!;
    const { owner_user_id: _o, ...rest } = m;
    return { ...rest, owner: { user_id: owner.user_id, email: owner.email, display_name: owner.display_name }, project: { id: p['id'], slug: p['slug'], name: p['name'], visibility: p['visibility'] } };
  };

  /** Wraps a handler with bearer auth; 401 copies the real error body. */
  const authed =
    (fn: (ctx: { user: FakeUser; params: Record<string, string>; request: Request; url: URL; body: Row }) => Response | Promise<Response>) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      const user = auth(request);
      if (!user) return fail(401, 'unauthorized', 'invalid or expired token');
      const body = request.method === 'GET' || request.method === 'DELETE' ? {} : ((await request.json().catch(() => ({}))) as Row);
      return fn({ user, params: params as Record<string, string>, request, url: new URL(request.url), body });
    };

  const v1 = (path: string) => `${baseUrl}/v1${path}`;

  const grantRoutes = (segment: 'projects' | 'sessions'): HttpHandler[] => {
    const type = segment === 'projects' ? 'project' : 'session';
    return [
      http.get(
        v1(`/${segment}/:id/grants`),
        authed(({ user, params }) => (owns(user, type, params['id']) ? ok(grants.filter((g) => g['resource_type'] === type && g['resource_id'] === params['id'])) : fail(404, 'not_found', type))),
      ),
      http.put(
        v1(`/${segment}/:id/grants/:userId`),
        authed(({ user, params, body }) => {
          if (!owns(user, type, params['id'])) return fail(404, 'not_found', type);
          if (!['reader', 'editor', 'owner'].includes(String(body['role']))) return fail(400, 'validation_failed', 'role: Invalid enum value');
          let g = grants.find((x) => x['resource_type'] === type && x['resource_id'] === params['id'] && x['subject_id'] === params['userId']);
          if (g) g['role'] = body['role'];
          else grants.push((g = { id: uuid(), org_id: null, resource_type: type, resource_id: params['id'], subject_type: 'user', subject_id: params['userId'], role: body['role'], created_by: user.user_id, created_at: now() }));
          return ok(g);
        }),
      ),
      http.delete(
        v1(`/${segment}/:id/grants/:userId`),
        authed(({ user, params }) => {
          if (!owns(user, type, params['id'])) return fail(404, 'not_found', type);
          const i = grants.findIndex((x) => x['resource_type'] === type && x['resource_id'] === params['id'] && x['subject_id'] === params['userId']);
          if (i >= 0) grants.splice(i, 1);
          return ok({ revoked: i >= 0 });
        }),
      ),
    ];
  };

  const handlers: HttpHandler[] = [
    http.get(
      v1('/me'),
      authed(({ user }) => ok({ user_id: user.user_id, email: user.email, display_name: user.display_name, avatar_url: null, github_username: null, github_id: null, auth_provider: 'email', bio: null, created_at: now(), updated_at: now() })),
    ),
    http.get(
      v1('/orgs'),
      authed(({ user }) => ok(org.members.includes(user.user_id) ? [{ id: org.id, slug: org.slug, name: org.name, plan: org.plan, role: 'member', joined_at: now() }] : [])),
    ),
    http.get(
      v1('/orgs/slug/:slug/members'),
      authed(({ user, params }) =>
        params['slug'] === org.slug && org.members.includes(user.user_id)
          ? ok(org.members.map((id) => users.find((u) => u.user_id === id)!).map((u) => ({ user_id: u.user_id, role: 'member', joined_at: now(), email: u.email, display_name: u.display_name, avatar_url: null })))
          : fail(404, 'not_found', 'org'),
      ),
    ),

    http.get(
      v1('/projects/personal'),
      authed(({ user }) => ok({ ...personalOf(user), viewer_role: 'owner' })),
    ),
    http.get(
      v1('/projects'),
      authed(({ user }) => ok(projects.filter((p) => p['owner_user_id'] === user.user_id))),
    ),
    http.get(
      v1('/projects/:id'),
      authed(({ user, params }) => {
        const p = projects.find((x) => x['id'] === params['id']);
        return p && canRead(user, p['id']) ? ok({ ...p, viewer_role: p['owner_user_id'] === user.user_id ? 'owner' : null }) : fail(404, 'not_found', 'project');
      }),
    ),

    http.post(
      v1('/sessions'),
      authed(({ user, body }) => {
        const projectId = body['project_id'] ?? personalOf(user)['id'];
        if (!projects.some((p) => p['id'] === projectId && p['owner_user_id'] === user.user_id)) return fail(404, 'not_found', 'project');
        const t = now();
        const s = { id: uuid(), org_id: null, project_id: projectId, owner_user_id: user.user_id, source: body['source'] ?? 'mcp', client: body['client'] ?? null, title: body['title'] ?? null, summary: null, status: 'open', started_at: t, ended_at: null, last_activity_at: t, metadata: body['metadata'] ?? {}, created_at: t, updated_at: t };
        sessions.push(s);
        return ok(s, null, 201);
      }),
    ),
    http.get(
      v1('/sessions'),
      authed(({ user, url }) => {
        const projectId = url.searchParams.get('project_id') ?? personalOf(user)['id'];
        if (!canRead(user, projectId)) return fail(404, 'not_found', 'project');
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const all = sessions.filter((s) => s['project_id'] === projectId).sort((a, b) => String(b['started_at']).localeCompare(String(a['started_at'])));
        return ok(all.slice(0, limit), { total: all.length, offset: 0, limit, has_more: all.length > limit });
      }),
    ),
    http.get(
      v1('/sessions/:id'),
      authed(({ user, params }) => {
        const s = sessions.find((x) => x['id'] === params['id']);
        const granted = grants.some((g) => g['resource_type'] === 'session' && g['resource_id'] === params['id'] && g['subject_id'] === user.user_id);
        if (!s || !(canRead(user, s['project_id']) || granted)) return fail(404, 'not_found', 'session');
        return ok({ session: s, turns: turns.filter((t) => t['session_id'] === s['id']), memories: memories.filter((m) => m['session_id'] === s['id']).map(memoryRecord) });
      }),
    ),
    http.post(
      v1('/sessions/:id/turns'),
      authed(({ user, params, body }) => {
        const s = sessions.find((x) => x['id'] === params['id'] && x['owner_user_id'] === user.user_id);
        if (!s) return fail(404, 'not_found', 'session');
        if (typeof body['content'] !== 'string' || !body['content']) return fail(400, 'validation_failed', 'content: Required');
        const t = { id: uuid(), session_id: s['id'], seq: turns.filter((x) => x['session_id'] === s['id']).length + 1, role: body['role'], content: body['content'], created_at: now(), metadata: {} };
        turns.push(t);
        return ok(t, null, 201);
      }),
    ),
    http.post(
      v1('/sessions/:id/close'),
      authed(({ user, params, body }) => {
        const s = sessions.find((x) => x['id'] === params['id'] && x['owner_user_id'] === user.user_id);
        if (!s) return fail(404, 'not_found', 'session');
        Object.assign(s, { status: 'closed', summary: body['summary'] ?? null, ended_at: now(), updated_at: now() });
        return ok(s);
      }),
    ),

    http.post(
      v1('/memories'),
      authed(({ user, body }) => {
        const projectId = body['project_id'] ?? personalOf(user)['id'];
        if (!projects.some((p) => p['id'] === projectId && p['owner_user_id'] === user.user_id)) return fail(404, 'not_found', 'project');
        const t = now();
        const session = sessions.find((s) => s['id'] === body['session_id']);
        const m = { id: uuid(), org_id: null, project_id: projectId, owner_user_id: user.user_id, content: body['content'], kind: body['kind'] ?? 'note', category: body['category'] ?? null, tags: [], visibility: body['visibility'] ?? 'project', confidence: 1, importance: 0.5, decay_lambda: 0.01, importance_at: t, importance_now: 0.5, decay_state: 'warm', access_count: 0, last_accessed_at: null, source_refs: [], superseded_by: null, archived: false, created_at: t, updated_at: t, session_id: body['session_id'] ?? null, source: session?.['source'] ?? null };
        memories.push(m);
        return ok(memoryRecord(m), null, 201);
      }),
    ),
    http.delete(
      v1('/memories/:id'),
      authed(({ user, params }) => {
        const m = memories.find((x) => x['id'] === params['id'] && x['owner_user_id'] === user.user_id);
        if (!m) return fail(404, 'not_found', 'memory');
        m['archived'] = true; // the real server archives; the row still rides on the session payload
        return ok({ id: m['id'], archived: true });
      }),
    ),
    http.post(
      v1('/memories/recall'),
      authed(({ user, body }) => {
        const projectId = body['project_id'] ?? personalOf(user)['id'];
        if (!canRead(user, projectId)) return fail(404, 'not_found', 'project');
        const words = String(body['query'] ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const hits = memories
          .filter((m) => m['project_id'] === projectId && !m['archived'])
          .map((m) => ({ m, score: words.filter((w) => String(m['content']).toLowerCase().includes(w)).length }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(body['limit'] ?? 10))
          .map(({ m, score }) => ({ ...memoryRecord(m), similarity: Math.min(1, score / 4), source_scope: 'workspace', effective_importance: 0.5 }));
        return ok(hits, { query_ms: 1 });
      }),
    ),
    ...grantRoutes('projects'),
    ...grantRoutes('sessions'),
  ];

  return { handlers, users, tokens: { a: users[0]!.token, b: users[1]!.token, c: users[2]!.token } };
}
