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
 *   - spaces (probed on api.openkt.ai 2026-09-19): POST /v1/projects {name, slug} → the project; a slug the owner
 *     already has → 400 validation_error "project slug already exists" (projects_org_slug_unique); GET /v1/projects
 *     lists owned AND granted projects; GET /v1/projects/:id adds viewer_role (owner | admin | member | viewer —
 *     a grant's owner/editor/reader); a grantee may search a space (POST /v1/memories/search, every id authorised)
 *     and write into it as an editor
 *   - living pages (modules/pages, #100): GET /v1/projects/:id/pages → [] with meta.processing, GET /v1/projects/:id/brief
 *     → {brief_md: null}, GET /v1/pages/:id → 404 — a space's pages exist only once a Mac has processed its sessions
 *   - optional routes answer the way Nest does when they are missing — 404 `http_exception` "Cannot PATCH /v1/…" —
 *     unless a test turns them on: `state.moveSession` (PATCH /v1/sessions/:id {project_id}; on no server yet) and
 *     `state.joinLinks` (modules/teams, #86: POST /v1/projects/:id/join-links {role} by an owner or editor →
 *     JoinLinkView {code, url, space_id, role, …}; POST /v1/join {code} → {space: {id, name}, role}, 404 for an
 *     unknown code)
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
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
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
  const state = {
    google: { enabled: true, client_id: 'test-client.apps.googleusercontent.com' } as { enabled: boolean; client_id?: string; client_secret?: string },
    rateLimited: false,
    /** Mimic the live server's ambiguity: /projects/personal answers with the newest private project, not the personal one. */
    personalAmbiguous: false,
    /** Routes production does not have yet. Off: Nest's "Cannot PATCH …" 404. */
    moveSession: false,
    joinLinks: false,
  };
  const joinLinks: { code: string; project_id: string; role: string }[] = [];
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
  const grantRole = (u: FakeUser, projectId: unknown) => grants.find((g) => g['resource_type'] === 'project' && g['resource_id'] === projectId && g['subject_id'] === u.user_id)?.['role'];
  const canWrite = (u: FakeUser, projectId: unknown) =>
    projects.some((p) => p['id'] === projectId && p['owner_user_id'] === u.user_id) || ['editor', 'owner'].includes(String(grantRole(u, projectId)));
  const viewerRole = (u: FakeUser, p: Row) => (p['owner_user_id'] === u.user_id ? 'owner' : ({ owner: 'admin', editor: 'member', reader: 'viewer' } as Record<string, string>)[String(grantRole(u, p['id']))] ?? null);
  /** What Nest answers for a route it does not have. */
  const noRoute = (request: Request) => fail(404, 'http_exception', `Cannot ${request.method} ${new URL(request.url).pathname}`);
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
      authed(({ user }) => {
        const personal = personalOf(user);
        const newest = projects.filter((p) => p['owner_user_id'] === user.user_id && p['visibility'] === 'personal' && !p['org_id']).at(-1);
        return ok({ ...(state.personalAmbiguous && newest ? newest : personal), viewer_role: 'owner' });
      }),
    ),
    http.get(
      v1('/projects'),
      // Owned and granted, as the live server lists them (checked against api.openkt.ai 2026-09-19).
      authed(({ user }) => ok(projects.filter((p) => canRead(user, p['id'])))),
    ),
    http.post(
      v1('/projects'),
      authed(({ user, body }) => {
        const slug = String(body['slug'] ?? '');
        const name = String(body['name'] ?? '');
        if (!name || name.length > 120) return fail(400, 'validation_error', 'invalid request payload');
        if (body['slug'] !== undefined && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return fail(400, 'validation_error', 'invalid request payload');
        const mine = new Set(projects.filter((p) => p['owner_user_id'] === user.user_id).map((p) => String(p['slug'])));
        // A slug this owner already has: the server's own words for it (projects_org_slug_unique). No slug: one made from the name.
        if (body['slug'] !== undefined && mine.has(slug)) return fail(400, 'validation_error', 'project slug already exists');
        let made = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'space';
        for (let n = 2; mine.has(made) || made === 'personal'; n += 1) made = `${(slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 36)}-${n}`;
        return ok(project(user, made, name), null, 201);
      }),
    ),
    http.get(
      v1('/projects/:id'),
      authed(({ user, params }) => {
        const p = projects.find((x) => x['id'] === params['id']);
        return p && canRead(user, p['id']) ? ok({ ...p, viewer_role: viewerRole(user, p) }) : fail(404, 'not_found', 'project');
      }),
    ),
    // Living pages (server modules/pages, #100): a new space has no pages, no brief, nothing waiting.
    http.get(
      v1('/projects/:id/pages'),
      authed(({ user, params }) =>
        canRead(user, params['id'])
          ? ok([], { processing: { queued: 0, claimed: 0, failed: 0, oldest_queued_at: null, last_done_at: null, last_done_by: null } })
          : fail(404, 'not_found', 'project'),
      ),
    ),
    http.get(
      v1('/projects/:id/brief'),
      authed(({ user, params }) => (canRead(user, params['id']) ? ok({ brief_md: null, updated_at: null }) : fail(404, 'not_found', 'project'))),
    ),
    http.get(
      v1('/pages/:id'),
      authed(() => fail(404, 'not_found', 'page')),
    ),
    http.post(
      v1('/projects/:id/join-links'),
      authed(({ user, params, body, request }) => {
        if (!state.joinLinks) return noRoute(request);
        if (!canRead(user, params['id'])) return fail(404, 'not_found', 'project');
        if (!canWrite(user, params['id'])) return fail(403, 'forbidden', 'only an owner or editor can invite');
        const role = String(body['role'] ?? 'editor');
        if (!['reader', 'editor'].includes(role)) return fail(400, 'validation_error', 'role: Invalid enum value');
        const code = uuid().replace(/-/g, '').slice(0, 10);
        joinLinks.push({ code, project_id: String(params['id']), role });
        const t = now();
        return ok({ code, url: `https://api.openkt.ai/join/${code}`, space_id: params['id'], role, created_by: user.user_id, created_at: t, expires_at: null, max_uses: null, uses: 0, active: true }, null, 201);
      }),
    ),
    http.post(
      v1('/join'),
      authed(({ user, body, request }) => {
        if (!state.joinLinks) return noRoute(request);
        const code = String(body['code'] ?? '');
        if (!code) return fail(400, 'validation_error', 'code: Required');
        // A whole link works as well as the code in it.
        const link = joinLinks.find((l) => l.code === (/\/join\/([A-Za-z0-9]+)/.exec(code)?.[1] ?? code));
        if (!link) return fail(404, 'not_found', 'This invite link does not exist, has expired or has been used up.');
        const p = projects.find((x) => x['id'] === link.project_id)!;
        if (!canRead(user, p['id'])) grants.push({ id: uuid(), org_id: null, resource_type: 'project', resource_id: p['id'], subject_type: 'user', subject_id: user.user_id, role: link.role, created_by: p['owner_user_id'], created_at: now() });
        return ok({ space: { id: p['id'], name: p['name'] }, role: p['owner_user_id'] === user.user_id ? 'owner' : String(grantRole(user, p['id'])) });
      }),
    ),

    http.post(
      v1('/sessions'),
      authed(({ user, body }) => {
        const projectId = body['project_id'] ?? personalOf(user)['id'];
        if (!canWrite(user, projectId)) return fail(404, 'not_found', 'project');
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
    http.patch(
      v1('/sessions/:id'),
      authed(({ user, params, body, request }) => {
        if (!state.moveSession) return noRoute(request);
        const s = sessions.find((x) => x['id'] === params['id']);
        if (!s || !canRead(user, s['project_id'])) return fail(404, 'not_found', 'session');
        if (s['owner_user_id'] !== user.user_id) return fail(403, 'forbidden', 'only the session owner can move it');
        if (!canWrite(user, body['project_id'])) return fail(404, 'not_found', 'project');
        Object.assign(s, { project_id: body['project_id'], updated_at: now() });
        for (const m of memories) if (m['session_id'] === s['id']) m['project_id'] = body['project_id'];
        return ok(s);
      }),
    ),
    http.post(
      v1('/sessions/:id/turns'),
      authed(({ user, params, body }) => {
        const s = sessions.find((x) => x['id'] === params['id'] && canWrite(user, x['project_id']));
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
        const s = sessions.find((x) => x['id'] === params['id'] && canWrite(user, x['project_id']));
        if (!s) return fail(404, 'not_found', 'session');
        Object.assign(s, { status: 'closed', summary: body['summary'] ?? null, ended_at: now(), updated_at: now() });
        return ok(s);
      }),
    ),

    http.post(
      v1('/memories'),
      authed(({ user, body }) => {
        const projectId = body['project_id'] ?? personalOf(user)['id'];
        if (!canWrite(user, projectId)) return fail(404, 'not_found', 'project');
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
        // The live server widens a personal-visibility project to the caller's other private projects
        // (ProjectScopeService.workspaceRing); a project shared with the caller is searched only when named.
        const primary = projects.find((p) => p['id'] === projectId);
        const ring = primary?.['visibility'] === 'personal' ? projects.filter((p) => p['owner_user_id'] === user.user_id && p['visibility'] === 'personal' && !p['org_id']).map((p) => p['id']) : [];
        const scope = new Set([projectId, ...ring]);
        const hits = memories
          .filter((m) => scope.has(m['project_id']) && !m['archived'])
          .map((m) => ({ m, score: words.filter((w) => String(m['content']).toLowerCase().includes(w)).length }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(body['limit'] ?? 10))
          .map(({ m, score }) => ({ ...memoryRecord(m), similarity: Math.min(1, score / 4), source_scope: 'workspace', effective_importance: 0.5 }));
        return ok(hits, { query_ms: 1 });
      }),
    ),
    http.post(
      v1('/memories/search'),
      authed(({ user, body }) => {
        const ids = (obj(body['filters'])['project_ids'] as unknown[] | undefined) ?? [];
        if (!ids.length) return fail(400, 'validation_error', 'search requires filters.project_ids with at least one project');
        // Every id is authorised; one unreadable id is a 404 for the whole request.
        if (ids.some((id) => !canRead(user, id))) return fail(404, 'not_found', 'project');
        const words = String(body['query'] ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const hits = memories
          .filter((m) => ids.includes(m['project_id']) && !m['archived'])
          .map((m) => ({ m, score: words.filter((w) => String(m['content']).toLowerCase().includes(w)).length }))
          .filter((x) => !words.length || x.score > 0)
          .sort((a, b) => b.score - a.score || String(b.m['created_at']).localeCompare(String(a.m['created_at'])))
          .slice(0, Math.min(100, Number(body['limit'] ?? 20)))
          .map(({ m, score }) => ({ ...memoryRecord(m), similarity: words.length ? Math.min(1, score / 4) : null, source_scope: 'primary', effective_importance: 0.5 }));
        return ok(hits, { total_matched: hits.length, mode: body['mode'] ?? 'hybrid', next_cursor: null, query_ms: 1 });
      }),
    ),
    ...grantRoutes('projects'),
    ...grantRoutes('sessions'),
    ...skillRoutes,
    ...grantRoutes('skills'),
    ...authRoutes,
  ];

  return { handlers, users, state, revoked, skills, projects, tokens: { a: users[0]!.token, b: users[1]!.token, c: users[2]!.token } };
}
