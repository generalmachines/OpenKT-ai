/**
 * An in-memory OpenKT server for msw. Response shapes are copied from the
 * real server, not invented:
 *   - envelope `{data, error, meta}` and errors `{data:null, error:{code,message,details,request_id}}`
 *     (server/apps/server/src/common/http, common/filters/app-exception.filter.ts)
 *   - SessionRecord / SessionTurnRecord (modules/sessions/contracts/session.contract.ts)
 *   - MemoryRecord incl. owner/project/session_id (modules/memory/contracts/memory.contract.ts)
 *   - GrantRecord, PUT/DELETE …/grants/:userId (modules/grants)
 *   - built-in accounts: /v1/auth/{providers,signup,login,google,logout}, and share-by-email
 *     `PUT …/grants {email, role}` → GrantView `{…record, pending:false, subject:{id,email,display_name}}`
 *     or PendingGrantView `{id, pending:true, email, role, …}`; the list carries both; DELETE takes a
 *     user id or a pending share's own id (modules/grants/contracts/grant.contract.ts on feat/built-in-accounts)
 *   - snake_case profile / project / org member rows, as observed on a live server 2026-09-19
 *   - skills: the contract the desktop was built against (GET/POST /v1/skills, GET/PUT/PATCH/DELETE /v1/skills/:id,
 *     /versions/:n, /versions/:n/restore, /runs, /grants with DELETE by user id or pending share id, like the
 *     other grants — modules/skills on feat/skills); 422 codes
 *     invalid_frontmatter | missing_skill_md | file_too_large | too_many_files | bad_path; 409 version_conflict;
 *     a skill the caller cannot read is a 404
 * Behaviour mirrors what the adapter relies on: one project per session list
 * (none → personal), owner-only grant management, delete = archive, recall
 * scoped to readable projects.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import { byteLength, filesProblem, parseFrontmatter, slugify, starterSkillMd } from '../../src/api/skillFiles';

type Row = Record<string, unknown>;
interface SkillRow {
  id: string;
  slug: string;
  title: string;
  project_id: string;
  owner_user_id: string;
  archived: boolean;
  /** Timestamps of recorded runs. */
  runs: number[];
  versions: { version: number; change_note: string; created_by: string; created_at: string; files: { path: string; content: string }[] }[];
}
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const ok = (data: unknown, meta: unknown = null, status = 200) => HttpResponse.json({ data, error: null, meta }, { status });
const fail = (status: number, code: string, message: string) => HttpResponse.json({ data: null, error: { code, message, details: null, request_id: uuid() }, meta: null }, { status });

export interface FakeUser {
  user_id: string;
  email: string;
  display_name: string;
  token: string;
  password?: string;
}

export function createFakeServer(baseUrl: string) {
  const users: FakeUser[] = [
    { user_id: 'e5c5b78e-ba07-5776-86f9-89b0da23bb3f', email: 'pratham@openkt.test', display_name: 'Pratham Bhatnagar', token: 'okt_pat_aaaa', password: 'correct horse battery' },
    { user_id: 'f72c9558-18db-54a4-860c-6a2f17a79721', email: 'ana@openkt.test', display_name: 'Ana Reyes', token: 'okt_pat_bbbb', password: 'staple staple staple' },
    { user_id: '0b1f6c1e-52f7-5d0b-9a39-3f7d0c1b2a44', email: 'stranger@elsewhere.test', display_name: 'Sam Stranger', token: 'okt_pat_cccc' },
  ];
  const org = { id: uuid(), slug: 'deepwork', name: 'Deepwork', plan: 'free', members: [users[0]!.user_id, users[1]!.user_id] };
  const projects: Row[] = [];
  const sessions: Row[] = [];
  const turns: Row[] = [];
  const memories: Row[] = [];
  const grants: Row[] = [];
  const skills: SkillRow[] = [];
  /** Knobs a test can turn. `google` is what /auth/providers answers; `rateLimited` makes every auth POST a 429. */
  const state = { google: { enabled: true, client_id: 'test-client.apps.googleusercontent.com' } as { enabled: boolean; client_id?: string; client_secret?: string }, rateLimited: false };
  const revoked = new Set<string>();

  const project = (owner: FakeUser, slug: string, name: string): Row => {
    const p = { id: uuid(), slug, name, visibility: 'personal', org_id: null, owner_user_id: owner.user_id, created_at: now(), updated_at: now() };
    projects.push(p);
    return p;
  };
  const personalOf = (u: FakeUser) => projects.find((p) => p['owner_user_id'] === u.user_id && p['slug'] === 'personal') ?? project(u, 'personal', 'Personal');
  project(users[0]!, 'northgate', 'Sales / Northgate');

  const auth = (request: Request): FakeUser | null => {
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    return token && !revoked.has(token) ? (users.find((u) => u.token === token) ?? null) : null;
  };
  const canRead = (u: FakeUser, projectId: unknown) =>
    projects.some((p) => p['id'] === projectId && p['owner_user_id'] === u.user_id) || grants.some((g) => g['resource_type'] === 'project' && g['resource_id'] === projectId && g['subject_id'] === u.user_id);
  const owns = (u: FakeUser, type: string, id: unknown) =>
    type === 'project'
      ? projects.some((p) => p['id'] === id && p['owner_user_id'] === u.user_id)
      : type === 'skill'
        ? skills.some((s) => s.id === id && s.owner_user_id === u.user_id)
        : sessions.some((s) => s['id'] === id && s['owner_user_id'] === u.user_id);

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

  /** What a grant row looks like on the wire: the person is spelled out, or marked pending. */
  const grantRecord = (g: Row): Row => {
    if (g['pending_email']) return { id: g['id'], resource_type: g['resource_type'], resource_id: g['resource_id'], pending: true, email: g['pending_email'], role: g['role'], created_by: g['created_by'], created_at: g['created_at'] };
    const u = users.find((x) => x.user_id === g['subject_id']);
    return { ...g, pending: false, subject: { id: g['subject_id'], email: u?.email ?? null, display_name: u?.display_name ?? null } };
  };

  const grantRoutes = (segment: 'projects' | 'sessions' | 'skills'): HttpHandler[] => {
    const type = segment === 'projects' ? 'project' : segment === 'skills' ? 'skill' : 'session';
    const find = (id: unknown, key: 'subject_id' | 'pending_email', value: unknown) => grants.find((x) => x['resource_type'] === type && x['resource_id'] === id && x[key] === value);
    const upsert = (user: FakeUser, id: unknown, key: 'subject_id' | 'pending_email', value: unknown, role: unknown): Row => {
      let g = find(id, key, value);
      if (g) g['role'] = role;
      else grants.push((g = { id: uuid(), org_id: null, resource_type: type, resource_id: id, subject_type: 'user', subject_id: key === 'subject_id' ? value : null, ...(key === 'pending_email' ? { pending_email: value } : {}), role, created_by: user.user_id, created_at: now() }));
      return g;
    };
    const badRole = (role: unknown) => !['reader', 'editor', 'owner'].includes(String(role));
    return [
      http.get(
        v1(`/${segment}/:id/grants`),
        authed(({ user, params }) => (owns(user, type, params['id']) ? ok(grants.filter((g) => g['resource_type'] === type && g['resource_id'] === params['id']).map(grantRecord)) : fail(404, 'not_found', type))),
      ),
      http.put(
        v1(`/${segment}/:id/grants`),
        authed(({ user, params, body }) => {
          if (!owns(user, type, params['id'])) return fail(404, 'not_found', type);
          if (badRole(body['role'])) return fail(400, 'validation_failed', 'role: Invalid enum value');
          const email = String(body['email'] ?? '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'validation_failed', 'email: Invalid email');
          const person = users.find((u) => u.email.toLowerCase() === email);
          if (person) return ok(grantRecord(upsert(user, params['id'], 'subject_id', person.user_id, body['role'])));
          return ok(grantRecord(upsert(user, params['id'], 'pending_email', email, body['role'])));
        }),
      ),
      http.put(
        v1(`/${segment}/:id/grants/:userId`),
        authed(({ user, params, body }) => {
          if (!owns(user, type, params['id'])) return fail(404, 'not_found', type);
          if (badRole(body['role'])) return fail(400, 'validation_failed', 'role: Invalid enum value');
          return ok(grantRecord(upsert(user, params['id'], 'subject_id', params['userId'], body['role'])));
        }),
      ),
      http.delete(
        v1(`/${segment}/:id/grants/:key`),
        authed(({ user, params }) => {
          if (!owns(user, type, params['id'])) return fail(404, 'not_found', type);
          const key = params['key'] ?? '';
          if (!/^[0-9a-f-]{36}$/.test(key)) return fail(400, 'validation_failed', 'userId: Invalid uuid');
          const i = grants.findIndex((x) => x['resource_type'] === type && x['resource_id'] === params['id'] && (x['subject_id'] === key || (x['pending_email'] && x['id'] === key)));
          if (i >= 0) grants.splice(i, 1);
          return ok({ revoked: i >= 0 });
        }),
      ),
    ];
  };

  // ── skills ────────────────────────────────────────────────────────────
  const roleOn = (u: FakeUser, s: SkillRow): string | null => {
    if (s.archived) return null;
    if (s.owner_user_id === u.user_id) return 'owner';
    const direct = grants.find((g) => g['resource_type'] === 'skill' && g['resource_id'] === s.id && g['subject_id'] === u.user_id);
    if (direct) return String(direct['role']);
    const viaSpace = grants.find((g) => g['resource_type'] === 'project' && g['resource_id'] === s.project_id && g['subject_id'] === u.user_id);
    if (viaSpace) return String(viaSpace['role']);
    return projects.some((p) => p['id'] === s.project_id && p['owner_user_id'] === u.user_id) ? 'owner' : null;
  };
  const person = (id: string) => {
    const u = users.find((x) => x.user_id === id);
    return { id, display_name: u?.display_name ?? null, email: u?.email ?? null };
  };
  const skillHead = (u: FakeUser, s: SkillRow): Row => {
    const current = s.versions[s.versions.length - 1]!;
    const main = current.files.find((f) => f.path === 'SKILL.md')?.content ?? '';
    const since = Date.now() - 30 * 86_400_000;
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      description: parseFrontmatter(main)?.description ?? '',
      project_id: s.project_id,
      space_name: String(projects.find((p) => p['id'] === s.project_id)?.['name'] ?? ''),
      owner: person(s.owner_user_id),
      current_version: current.version,
      updated_at: current.created_at,
      run_count_30d: s.runs.filter((t) => t >= since).length,
      my_role: roleOn(u, s),
    };
  };
  const skillDetail = (u: FakeUser, s: SkillRow): Row => ({
    ...skillHead(u, s),
    files: s.versions[s.versions.length - 1]!.files.map((f) => ({ ...f, bytes: byteLength(f.content) })),
    versions: [...s.versions].reverse().map((v) => ({ version: v.version, change_note: v.change_note, created_by: person(v.created_by), created_at: v.created_at })),
  });
  const readable = (u: FakeUser, id: unknown): SkillRow | null => {
    const s = skills.find((x) => x.id === id);
    return s && roleOn(u, s) ? s : null;
  };
  const checked = (files: unknown): { files: { path: string; content: string }[] } | Response => {
    const list = (Array.isArray(files) ? files : []).map((f) => ({ path: String((f as Row)['path'] ?? ''), content: String((f as Row)['content'] ?? '') }));
    const problem = filesProblem(list);
    return problem ? fail(422, problem.code, problem.message) : { files: list };
  };
  const skillRoutes: HttpHandler[] = [
    http.get(
      v1('/skills'),
      authed(({ user, url }) => {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const projectId = url.searchParams.get('project_id');
        const rows = skills
          .filter((s) => roleOn(user, s) && (!projectId || s.project_id === projectId))
          .map((s) => skillHead(user, s))
          .filter((r) => !q || `${r['title']} ${r['slug']} ${r['description']}`.toLowerCase().includes(q));
        return ok(rows);
      }),
    ),
    http.post(
      v1('/skills'),
      authed(({ user, body }) => {
        const title = String(body['title'] ?? '').trim();
        if (!title) return fail(400, 'validation_failed', 'title: Required');
        const projectId = String(body['project_id'] ?? personalOf(user)['id']);
        if (!projects.some((p) => p['id'] === projectId && p['owner_user_id'] === user.user_id)) return fail(404, 'not_found', 'project');
        const result = checked(Array.isArray(body['files']) && body['files'].length ? body['files'] : [{ path: 'SKILL.md', content: starterSkillMd(title) }]);
        if (result instanceof Response) return result;
        const s: SkillRow = { id: uuid(), slug: slugify(title), title, project_id: projectId, owner_user_id: user.user_id, archived: false, runs: [], versions: [{ version: 1, change_note: '', created_by: user.user_id, created_at: now(), files: result.files }] };
        skills.push(s);
        return ok(skillDetail(user, s), null, 201);
      }),
    ),
    http.get(
      v1('/skills/:id'),
      authed(({ user, params }) => {
        const s = readable(user, params['id']);
        return s ? ok(skillDetail(user, s)) : fail(404, 'not_found', 'skill');
      }),
    ),
    http.get(
      v1('/skills/:id/versions/:n'),
      authed(({ user, params }) => {
        const v = readable(user, params['id'])?.versions.find((x) => x.version === Number(params['n']));
        return v ? ok({ version: v.version, files: v.files.map((f) => ({ ...f, bytes: byteLength(f.content) })) }) : fail(404, 'not_found', 'skill version');
      }),
    ),
    http.put(
      v1('/skills/:id'),
      authed(({ user, params, body }) => {
        const s = readable(user, params['id']);
        if (!s) return fail(404, 'not_found', 'skill');
        if (roleOn(user, s) === 'reader') return fail(403, 'forbidden', 'editors only');
        const result = checked(body['files']);
        if (result instanceof Response) return result;
        const current = s.versions[s.versions.length - 1]!.version;
        if (Number(body['base_version']) !== current) return fail(409, 'version_conflict', `version ${current} was saved first`);
        s.versions.push({ version: current + 1, change_note: String(body['change_note'] ?? ''), created_by: user.user_id, created_at: now(), files: result.files });
        return ok(skillDetail(user, s));
      }),
    ),
    http.post(
      v1('/skills/:id/versions/:n/restore'),
      authed(({ user, params }) => {
        const s = readable(user, params['id']);
        const v = s?.versions.find((x) => x.version === Number(params['n']));
        if (!s || !v) return fail(404, 'not_found', 'skill version');
        if (roleOn(user, s) === 'reader') return fail(403, 'forbidden', 'editors only');
        s.versions.push({ version: s.versions[s.versions.length - 1]!.version + 1, change_note: `restored v${v.version}`, created_by: user.user_id, created_at: now(), files: v.files.map((f) => ({ ...f })) });
        return ok(skillDetail(user, s));
      }),
    ),
    http.patch(
      v1('/skills/:id'),
      authed(({ user, params, body }) => {
        const s = readable(user, params['id']);
        if (!s) return fail(404, 'not_found', 'skill');
        if (roleOn(user, s) !== 'owner') return fail(403, 'forbidden', 'owners only');
        if (body['project_id'] !== undefined) {
          if (!projects.some((p) => p['id'] === body['project_id'] && p['owner_user_id'] === user.user_id)) return fail(404, 'not_found', 'project');
          s.project_id = String(body['project_id']);
        }
        const head = skillHead(user, s);
        if (typeof body['archived'] === 'boolean') s.archived = body['archived'];
        return ok(head);
      }),
    ),
    http.delete(
      v1('/skills/:id'),
      authed(({ user, params }) => {
        const s = readable(user, params['id']);
        if (!s) return fail(404, 'not_found', 'skill');
        if (roleOn(user, s) !== 'owner') return fail(403, 'forbidden', 'owners only');
        skills.splice(skills.indexOf(s), 1);
        return ok({ deleted: true });
      }),
    ),
    http.post(
      v1('/skills/:id/runs'),
      authed(({ user, params, body }) => {
        const s = readable(user, params['id']);
        if (!s) return fail(404, 'not_found', 'skill');
        if (body['surface'] !== 'app') return fail(400, 'validation_failed', 'surface: Invalid enum value');
        s.runs.push(Date.now());
        return ok({ version: s.versions[s.versions.length - 1]!.version, files: s.versions[s.versions.length - 1]!.files.map((f) => ({ ...f, bytes: byteLength(f.content) })) }, null, 201);
      }),
    ),
  ];

  // ── built-in accounts ─────────────────────────────────────────────────
  const open = async (request: Request): Promise<Row> => (await request.json().catch(() => ({}))) as Row;
  const sessionFor = (u: FakeUser, extra: Row = {}, status = 200) => ok({ token: u.token, expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), user: { id: u.user_id, email: u.email, display_name: u.display_name }, ...extra }, null, status);
  const enroll = (email: string, display_name: string, password?: string): FakeUser => {
    const u: FakeUser = { user_id: uuid(), email, display_name, token: `okt_pat_${uuid().replace(/-/g, '')}`, password };
    users.push(u);
    // Invitations that were waiting for this email take effect now.
    for (const g of grants) if (g['pending_email'] === email.toLowerCase()) Object.assign(g, { subject_id: u.user_id, pending_email: undefined });
    return u;
  };
  const authRoutes: HttpHandler[] = [
    http.get(v1('/auth/providers'), () => ok({ password: true, google: state.google })),
    http.post(v1('/auth/signup'), async ({ request }) => {
      if (state.rateLimited) return fail(429, 'rate_limited', 'too many attempts');
      const body = await open(request);
      const email = String(body['email'] ?? '').trim().toLowerCase();
      const password = String(body['password'] ?? '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !String(body['display_name'] ?? '').trim()) return fail(422, 'validation_failed', 'email: Invalid email');
      if (users.some((u) => u.email.toLowerCase() === email)) return fail(409, 'email_taken', 'an account with that email already exists');
      if (password.length < 10) return fail(400, 'weak_password', 'password must be at least 10 characters');
      return sessionFor(enroll(email, String(body['display_name']).trim(), password), {}, 201);
    }),
    http.post(v1('/auth/login'), async ({ request }) => {
      if (state.rateLimited) return fail(429, 'rate_limited', 'too many attempts');
      const body = await open(request);
      const u = users.find((x) => x.email.toLowerCase() === String(body['email'] ?? '').trim().toLowerCase());
      if (!u || !u.password || u.password !== body['password']) return fail(401, 'invalid_credentials', 'invalid email or password');
      revoked.delete(u.token);
      return sessionFor(u);
    }),
    http.post(v1('/auth/google'), async ({ request }) => {
      if (!state.google.enabled) return fail(404, 'provider_disabled', 'google sign-in is not configured');
      // A stand-in id_token: "google:<email>:<name>". The real server verifies Google's signature and audience.
      const m = /^google:([^:]+):?(.*)$/.exec(String((await open(request))['id_token'] ?? ''));
      if (!m) return fail(401, 'invalid_credentials', 'invalid id_token');
      const u = users.find((x) => x.email.toLowerCase() === m[1]!.toLowerCase()) ?? enroll(m[1]!.toLowerCase(), m[2] || m[1]!);
      revoked.delete(u.token);
      return sessionFor(u);
    }),
    http.post(
      v1('/auth/logout'),
      authed(({ user }) => {
        revoked.add(user.token);
        return new HttpResponse(null, { status: 204 });
      }),
    ),
  ];

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
    ...skillRoutes,
    ...grantRoutes('skills'),
    ...authRoutes,
  ];

  return { handlers, users, state, revoked, skills, tokens: { a: users[0]!.token, b: users[1]!.token, c: users[2]!.token } };
}
