import { NotFoundError, type OpenKTClient } from '../client';
import { ApiError } from '../errors';
import { filesProblem, parseFrontmatter, SKILL_MD, slugify, starterSkillMd, toSkillFile } from '../skillFiles';
import { joinCodeFrom, nextFreeSlug, spaceSlug } from '../spaces';
import type {
  Capabilities,
  Connector,
  ContextItem,
  Grant,
  GrantSubject,
  Id,
  JoinLink,
  ModelJob,
  ModelSettings,
  NewSkillInput,
  NewFactInput,
  NewSessionInput,
  NewSpaceInput,
  RecallHit,
  ResourceRef,
  Role,
  SaveSkillInput,
  Session,
  SessionListItem,
  Skill,
  SkillFile,
  SkillFileInput,
  SkillSummary,
  Space,
  SpaceMember,
  SpaceMembers,
} from '../types';
import { sourceLabel } from '../format';
import { createSeed, type SeedData } from './seed';
import type { SeedSkill } from './skills';

const clone = <T,>(v: T): T => structuredClone(v);

function sameResource(a: ResourceRef, b: ResourceRef): boolean {
  return a.type === b.type && a.id === b.id;
}

function stripTurns(s: Session): SessionListItem {
  const { turns: _turns, ...rest } = s;
  return rest;
}

/**
 * In-memory adapter. Reads return copies; mutations change the store and
 * notify subscribers, so the UI behaves as it will against a real server.
 */
export class MockClient implements OpenKTClient {
  readonly kind = 'mock' as const;
  private db: SeedData;
  private listeners = new Set<() => void>();
  private seq = 0;
  private joinLinks: (JoinLink & { spaceId: Id })[] = [];
  /** Spaces made here count their people from their grants; the sample ones keep the canvas's numbers. */
  private made = new Set<Id>();

  constructor(seed: SeedData = createSeed()) {
    this.db = seed;
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

  private nextId(prefix: string): Id {
    this.seq += 1;
    return `${prefix}-new-${this.seq}`;
  }

  /** Everything is sample data here, and the Workspace setting already says so — no per-screen badge. */
  readonly preview: ReadonlySet<never> = new Set();

  async getMe() {
    const me = this.db.workspace.me;
    return { id: me.id, name: me.name, initials: me.initials, email: me.email ?? `${me.name.split(' ')[0]?.toLowerCase() ?? 'me'}@example.com` };
  }

  async getWorkspace() {
    return clone(this.db.workspace);
  }

  async capabilities(): Promise<Capabilities> {
    return { moveSession: true, joinLinks: true };
  }

  /** Sample spaces predate owners: the person using the sample owns them. */
  private spaceView(s: Space): Space {
    const view = { ...clone(s), ownerId: s.ownerId ?? this.db.workspace.me.id, myRole: s.myRole ?? 'owner' };
    if (this.made.has(s.id)) {
      const grants = this.db.grants.filter((g) => sameResource(g.resource, { type: 'space', id: s.id }) && !g.pending);
      const teams = this.db.workspace.teams;
      view.memberCount = grants.reduce((n, g) => n + (g.subject.type === 'team' ? (teams.find((t) => t.id === g.subject.id)?.memberCount ?? 0) : 1), 0);
    }
    return view;
  }

  private space(id: Id): Space {
    const s = this.db.spaces.find((x) => x.id === id);
    if (!s) throw new NotFoundError('space', id);
    return s;
  }

  async listSpaces() {
    return this.db.spaces.map((s) => this.spaceView(s));
  }

  async getSpace(id: Id) {
    return this.spaceView(this.space(id));
  }

  async createSpace(input: NewSpaceInput): Promise<Space> {
    const name = input.name.trim();
    if (!name) throw new ApiError('invalid', 'Give the space a name.', 400, 'validation_error', '/projects');
    const me = this.db.workspace.me;
    const { slug } = nextFreeSlug(spaceSlug(name), new Set(this.db.spaces.map((s) => s.slug)));
    const space: Space = {
      id: this.nextId('sp'),
      name,
      slug,
      description: input.description?.trim() ?? '',
      personal: false,
      memberCount: 1,
      pageCount: 0,
      sessionCount: 0,
      updatedAt: new Date().toISOString(),
      ownerId: me.id,
      myRole: 'owner',
    };
    this.db.spaces.push(space);
    this.made.add(space.id);
    this.db.grants.push({
      id: this.nextId('g'),
      resource: { type: 'space', id: space.id },
      subject: { type: 'user', id: me.id, name: me.name, initials: me.initials, email: me.email },
      role: 'owner',
      note: 'you · created this space',
    });
    this.changed();
    return this.spaceView(space);
  }

  async listSpaceMembers(spaceId: Id): Promise<SpaceMembers> {
    const space = this.spaceView(this.space(spaceId));
    const me = this.db.workspace.me;
    const members: SpaceMember[] = this.db.grants
      .filter((g) => sameResource(g.resource, { type: 'space', id: spaceId }))
      .map((g) => ({
        id: g.subject.id,
        name: g.subject.name,
        initials: g.subject.initials,
        email: g.subject.email,
        role: g.role,
        pending: g.pending || undefined,
        team: g.subject.type === 'team' || undefined,
        you: g.subject.id === me.id || undefined,
      }));
    if (space.ownerId === me.id && !members.some((m) => m.you)) members.unshift({ id: me.id, name: me.name, initials: me.initials, email: me.email, role: 'owner', you: true });
    return { members, complete: true };
  }

  async listSpaceContext(spaceId: Id, opts?: { limit?: number }): Promise<ContextItem[]> {
    this.space(spaceId);
    return clone(
      this.db.context
        .filter((c) => c.spaceId === spaceId && !c.supersededBy)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, opts?.limit ?? 20),
    );
  }

  async createJoinLink(spaceId: Id, role: Role): Promise<JoinLink> {
    const space = this.spaceView(this.space(spaceId));
    if (space.myRole !== 'owner') throw new ApiError('forbidden', 'only the space owner can invite', 403, 'forbidden', `/projects/${spaceId}/join-links`);
    const code = `${this.nextId('join').replace(/[^a-z0-9]/g, '')}${Math.random().toString(36).slice(2, 8)}`;
    const link = { code, url: `https://openkt.ai/join/${code}`, role, spaceId };
    this.joinLinks.push(link);
    return { code, url: link.url, role };
  }

  async joinSpace(linkOrCode: string): Promise<Space> {
    const code = joinCodeFrom(linkOrCode);
    const link = this.joinLinks.find((l) => l.code === code);
    if (!link) throw new ApiError('not-found', 'That invite link is not valid, or it has expired.', 404, 'not_found', '/join');
    const space = this.space(link.spaceId);
    const me = this.db.workspace.me;
    const mine = this.db.grants.find((g) => sameResource(g.resource, { type: 'space', id: space.id }) && g.subject.id === me.id);
    if (!mine) {
      this.db.grants.push({ id: this.nextId('g'), resource: { type: 'space', id: space.id }, subject: { type: 'user', id: me.id, name: me.name, initials: me.initials, email: me.email }, role: link.role, note: 'joined with a link' });
      space.memberCount += 1;
    }
    this.changed();
    return this.spaceView(space);
  }

  async listPages(spaceId: Id) {
    return this.db.pages
      .filter((p) => p.spaceId === spaceId)
      .map(({ id, spaceId: sp, title, summary, sessionCount, updatedAt }) => ({ id, spaceId: sp, title, summary, sessionCount, updatedAt }));
  }

  async getPage(id: Id) {
    const p = this.db.pages.find((x) => x.id === id);
    if (!p) throw new NotFoundError('page', id);
    return clone(p);
  }

  private personName(id: Id): string {
    return this.db.workspace.people.find((p) => p.id === id)?.name ?? '';
  }

  async listSessions(filter?: { spaceId?: Id; mine?: boolean }): Promise<SessionListItem[]> {
    const me = this.db.workspace.me.id;
    return this.db.sessions
      .filter((s) => (filter?.spaceId ? s.spaceId === filter.spaceId : true))
      .filter((s) => (filter?.mine ? s.authorId === me : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ ...clone(stripTurns(s)), authorName: this.personName(s.authorId) }));
  }

  async getSession(id: Id): Promise<Session> {
    const s = this.db.sessions.find((x) => x.id === id);
    if (!s) throw new NotFoundError('session', id);
    return { ...clone(s), authorName: this.personName(s.authorId) };
  }

  async moveSession(id: Id, spaceId: Id): Promise<Session> {
    const s = this.db.sessions.find((x) => x.id === id);
    if (!s) throw new NotFoundError('session', id);
    const to = this.space(spaceId);
    if (s.authorId !== this.db.workspace.me.id) throw new ApiError('forbidden', 'only the person who saved it can move it', 403, 'forbidden', `/sessions/${id}`);
    if (s.spaceId !== to.id) {
      const from = this.db.spaces.find((x) => x.id === s.spaceId);
      if (from) from.sessionCount = Math.max(0, from.sessionCount - 1);
      to.sessionCount += 1;
      s.spaceId = to.id;
      for (const c of this.db.context) if (c.sessionId === id) c.spaceId = to.id;
    }
    this.changed();
    return { ...clone(s), authorName: this.personName(s.authorId) };
  }

  async createSession(input: NewSessionInput) {
    const me = this.db.workspace.me;
    const id = this.nextId('s');
    const parts = (input.turns?.length ? input.turns : [input.text ?? '']).map((t) => t.trim()).filter(Boolean);
    const text = parts.join('\n');
    const speaker = me.name.split(' ')[0] ?? me.name;
    const session: Session = {
      id,
      source: input.source,
      title: input.title.trim() || 'Untitled note',
      summary: text,
      status: 'open',
      spaceId: input.spaceId,
      authorId: me.id,
      authorName: me.name,
      createdAt: new Date().toISOString(),
      extractedOn: input.extractedOn ?? 'device',
      turns: parts.map((t, i) => ({ id: `t${i + 1}`, speaker, at: 0, text: t })),
    };
    this.db.sessions.unshift(session);
    this.db.grants.push({
      id: this.nextId('g'),
      resource: { type: 'session', id },
      subject: { type: 'user', id: me.id, name: me.name, initials: me.initials },
      role: 'owner',
      note: 'you · created this session',
    });
    const space = this.db.spaces.find((s) => s.id === input.spaceId);
    if (space) space.sessionCount += 1;
    this.changed();
    return clone(session);
  }

  async closeSession(id: Id, summary?: string) {
    const s = this.db.sessions.find((x) => x.id === id);
    if (!s) throw new NotFoundError('session', id);
    s.status = 'closed';
    if (summary?.trim()) s.summary = summary.trim();
    this.changed();
    return clone(s);
  }

  async listContext(sessionId: Id): Promise<ContextItem[]> {
    return clone(this.db.context.filter((c) => c.sessionId === sessionId));
  }

  async saveFact(input: NewFactInput): Promise<ContextItem> {
    if (!this.db.sessions.some((x) => x.id === input.sessionId)) throw new NotFoundError('session', input.sessionId);
    const item: ContextItem = {
      id: this.nextId('c'),
      kind: input.kind ?? 'fact',
      statement: input.statement.trim(),
      author: this.db.workspace.me.name,
      authorId: this.db.workspace.me.id,
      sessionId: input.sessionId,
      spaceId: input.spaceId,
      tags: [],
      createdAt: new Date().toISOString(),
    };
    this.db.context.push(item);
    this.changed();
    return clone(item);
  }

  async deleteFact(id: Id): Promise<void> {
    this.db.context = this.db.context.filter((c) => c.id !== id);
    this.changed();
  }

  async listGrants(resource: ResourceRef): Promise<Grant[]> {
    return clone(this.db.grants.filter((g) => sameResource(g.resource, resource)));
  }

  async putGrant(resource: ResourceRef, subject: GrantSubject, role: Role): Promise<Grant> {
    const existing = this.db.grants.find(
      (g) => sameResource(g.resource, resource) && g.subject.type === subject.type && g.subject.id === subject.id,
    );
    if (existing) {
      existing.role = role;
      this.changed();
      return clone(existing);
    }
    const team = subject.type === 'team' ? this.db.workspace.teams.find((t) => t.id === subject.id) : undefined;
    const grant: Grant = {
      id: this.nextId('g'),
      resource,
      subject,
      role,
      note: team ? `${team.memberCount} people · added by you` : 'added by you',
    };
    this.db.grants.push(grant);
    this.changed();
    return clone(grant);
  }

  async inviteByEmail(resource: ResourceRef, email: string, role: Role): Promise<Grant> {
    const address = email.trim().toLowerCase();
    const person = this.db.workspace.people.find((p) => !p.external && p.email?.toLowerCase() === address);
    if (person) return this.putGrant(resource, { type: 'user', id: person.id, name: person.name, initials: person.initials, email: person.email }, role);
    const existing = this.db.grants.find((g) => sameResource(g.resource, resource) && g.subject.email?.toLowerCase() === address);
    if (existing) {
      existing.role = role;
      this.changed();
      return clone(existing);
    }
    // Nobody here has that email yet: the invitation waits for them.
    const grant: Grant = {
      id: this.nextId('g'),
      resource,
      subject: { type: 'user', id: `invited:${address}`, name: address, initials: address.slice(0, 2).toUpperCase(), email: address },
      role,
      note: 'added by you',
      pending: true,
    };
    this.db.grants.push(grant);
    this.changed();
    return clone(grant);
  }

  async deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id'>): Promise<void> {
    this.db.grants = this.db.grants.filter(
      (g) => !(sameResource(g.resource, resource) && g.subject.type === subject.type && g.subject.id === subject.id),
    );
    this.changed();
  }

  async listAccessDefaults() {
    return clone(this.db.accessDefaults);
  }

  async listConnectors() {
    return clone(this.db.connectors);
  }

  async updateConnector(id: Id, patch: Partial<Pick<Connector, 'defaultAccess' | 'connected'>>) {
    const c = this.db.connectors.find((x) => x.id === id);
    if (!c) throw new NotFoundError('connector', id);
    if (patch.defaultAccess !== undefined) c.defaultAccess = patch.defaultAccess;
    if (patch.connected !== undefined) {
      c.connected = patch.connected;
      if (c.id === 'cursor') c.detail = patch.connected ? 'found · ~/.cursor' : 'not connected';
    }
    this.changed();
    return clone(c);
  }

  // ── skills ────────────────────────────────────────────────────────────

  private skill(id: Id): SeedSkill {
    const s = this.db.skills.find((x) => x.id === id && !x.archived);
    // A skill you cannot read does not exist for you: the server says 404 for both.
    if (!s) throw new ApiError('not-found', 'skill not found', 404, 'not_found', `/skills/${id}`);
    return s;
  }

  private toSummary(s: SeedSkill): SkillSummary {
    const current = s.versions[s.versions.length - 1]!;
    const main = current.files.find((f) => f.path === SKILL_MD)?.content ?? '';
    const description = parseFrontmatter(main)?.description ?? '';
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      description,
      spaceId: s.spaceId,
      spaceName: s.spaceName,
      owner: { ...s.owner },
      currentVersion: current.version,
      updatedAt: current.createdAt,
      runCount30d: s.runCount30d,
      myRole: s.myRole,
    };
  }

  private toSkill(s: SeedSkill): Skill {
    const current = s.versions[s.versions.length - 1]!;
    return {
      ...this.toSummary(s),
      files: clone(current.files),
      versions: [...s.versions].reverse().map(({ files: _files, ...v }) => clone(v)),
    };
  }

  private checkFiles(files: readonly SkillFileInput[], path: string): SkillFile[] {
    const problem = filesProblem(files);
    if (problem) throw new ApiError('invalid', problem.message, 422, problem.code, path);
    return files.map(toSkillFile);
  }

  private mustEdit(s: SeedSkill): void {
    if (s.myRole === 'reader') throw new ApiError('forbidden', 'editors only', 403, 'forbidden', `/skills/${s.id}`);
  }

  private pushVersion(s: SeedSkill, files: SkillFile[], changeNote: string, by = this.db.workspace.me): void {
    const last = s.versions[s.versions.length - 1]!;
    s.versions.push({ version: last.version + 1, changeNote, createdBy: { id: by.id, name: by.name }, createdAt: new Date().toISOString(), files });
  }

  async listSkills(filter?: { spaceId?: Id; q?: string }): Promise<SkillSummary[]> {
    const q = filter?.q?.trim().toLowerCase() ?? '';
    return this.db.skills
      .filter((s) => !s.archived)
      .filter((s) => (filter?.spaceId ? s.spaceId === filter.spaceId : true))
      .map((s) => this.toSummary(s))
      .filter((s) => !q || `${s.title} ${s.slug} ${s.description} ${s.spaceName}`.toLowerCase().includes(q));
  }

  async getSkill(id: Id): Promise<Skill> {
    return this.toSkill(this.skill(id));
  }

  async getSkillVersion(id: Id, version: number): Promise<SkillFile[]> {
    const v = this.skill(id).versions.find((x) => x.version === version);
    if (!v) throw new ApiError('not-found', 'version not found', 404, 'not_found', `/skills/${id}/versions/${version}`);
    return clone(v.files);
  }

  async createSkill(input: NewSkillInput): Promise<Skill> {
    const title = input.title.trim() || 'Untitled skill';
    const files = this.checkFiles(input.files?.length ? input.files : [{ path: SKILL_MD, content: starterSkillMd(title) }], '/skills');
    const me = this.db.workspace.me;
    const space = this.db.spaces.find((x) => x.id === input.spaceId) ?? this.db.spaces.find((x) => x.personal);
    const taken = new Set(this.db.skills.map((x) => x.slug));
    let slug = slugify(title);
    for (let n = 2; taken.has(slug); n += 1) slug = `${slugify(title).slice(0, 60)}-${n}`;
    const skill: SeedSkill = {
      id: this.nextId('sk'),
      slug,
      title,
      spaceId: space?.id ?? '',
      spaceName: space?.name ?? 'personal',
      owner: { id: me.id, name: me.name },
      runCount30d: 0,
      myRole: 'owner',
      versions: [{ version: 1, changeNote: '', createdBy: { id: me.id, name: me.name }, createdAt: new Date().toISOString(), files }],
    };
    this.db.skills.unshift(skill);
    this.db.grants.push({
      id: this.nextId('g'),
      resource: { type: 'skill', id: skill.id },
      subject: { type: 'user', id: me.id, name: me.name, initials: me.initials, email: me.email },
      role: 'owner',
      note: 'you · wrote this skill',
      inherited: true,
    });
    this.changed();
    return this.toSkill(skill);
  }

  async saveSkill(id: Id, input: SaveSkillInput): Promise<Skill> {
    const s = this.skill(id);
    this.mustEdit(s);
    const files = this.checkFiles(input.files, `/skills/${id}`);
    const current = s.versions[s.versions.length - 1]!.version;
    if (input.baseVersion !== current) throw new ApiError('conflict', `version ${current} was saved first`, 409, 'version_conflict', `/skills/${id}`);
    this.pushVersion(s, files, input.changeNote?.trim() ?? '');
    this.changed();
    return this.toSkill(s);
  }

  async restoreSkillVersion(id: Id, version: number): Promise<Skill> {
    const s = this.skill(id);
    this.mustEdit(s);
    const v = s.versions.find((x) => x.version === version);
    if (!v) throw new ApiError('not-found', 'version not found', 404, 'not_found', `/skills/${id}/versions/${version}`);
    this.pushVersion(s, clone(v.files), `restored v${version}`);
    this.changed();
    return this.toSkill(s);
  }

  async updateSkill(id: Id, patch: { spaceId?: Id; archived?: boolean }): Promise<SkillSummary> {
    const s = this.skill(id);
    if (s.myRole !== 'owner') throw new ApiError('forbidden', 'owners only', 403, 'forbidden', `/skills/${id}`);
    const space = patch.spaceId ? this.db.spaces.find((x) => x.id === patch.spaceId) : undefined;
    if (patch.spaceId && !space) throw new NotFoundError('space', patch.spaceId);
    if (space) Object.assign(s, { spaceId: space.id, spaceName: space.name });
    const summary = this.toSummary(s);
    if (patch.archived !== undefined) s.archived = patch.archived;
    this.changed();
    return summary;
  }

  async deleteSkill(id: Id): Promise<void> {
    const s = this.skill(id);
    if (s.myRole !== 'owner') throw new ApiError('forbidden', 'owners only', 403, 'forbidden', `/skills/${id}`);
    this.db.skills = this.db.skills.filter((x) => x.id !== id);
    this.db.grants = this.db.grants.filter((g) => !(g.resource.type === 'skill' && g.resource.id === id));
    this.changed();
  }

  async recordSkillRun(id: Id): Promise<SkillFile[]> {
    const s = this.skill(id);
    s.runCount30d += 1;
    this.changed();
    return clone(s.versions[s.versions.length - 1]!.files);
  }

  /** Sample data only: a teammate saves while you are editing, so the conflict path can be seen and tested. */
  simulateTeammateSave(id: Id, personId: Id, changeNote: string, edit: (files: SkillFile[]) => SkillFileInput[]): void {
    const s = this.skill(id);
    const by = this.db.workspace.people.find((p) => p.id === personId) ?? this.db.workspace.me;
    this.pushVersion(s, edit(clone(s.versions[s.versions.length - 1]!.files)).map(toSkillFile), changeNote, by);
  }

  async getModelSettings(): Promise<ModelSettings> {
    return clone(this.db.models);
  }

  async setModel(job: ModelJob, name: string) {
    const m = this.db.models.models.find((x) => x.job === job);
    if (!m) throw new NotFoundError('model job', job);
    m.name = name;
    this.changed();
    return clone(this.db.models);
  }

  async setModelEndpoint(endpoint: string) {
    this.db.models.endpoint = endpoint.trim();
    this.changed();
    return clone(this.db.models);
  }

  /**
   * Client-side stand-in for POST /v1/memories/recall: case-insensitive
   * substring match over sessions, context and pages. No ranking model.
   */
  async recall(query: string, opts?: { spaceId?: Id; limit?: number }): Promise<RecallHit[]> {
    const q = query.trim().toLowerCase();
    const limit = opts?.limit ?? 12;
    const inSpace = (spaceId: Id) => (opts?.spaceId ? spaceId === opts.spaceId : true);
    const spaceName = (id: Id) => this.db.spaces.find((s) => s.id === id)?.name ?? '';
    const hits: RecallHit[] = [];

    for (const s of this.db.sessions) {
      if (!inSpace(s.spaceId)) continue;
      if (!q || `${s.title} ${s.summary}`.toLowerCase().includes(q)) {
        hits.push({
          id: s.id,
          type: 'session',
          title: s.title,
          meta: `${sourceLabel(s.source)} · ${spaceName(s.spaceId)}`,
          source: s.source,
          author: this.personName(s.authorId),
          spaceName: spaceName(s.spaceId),
          href: `/sessions/${s.id}`,
        });
      }
    }
    if (q) {
      for (const p of this.db.pages) {
        if (!inSpace(p.spaceId)) continue;
        if (`${p.title} ${p.summary}`.toLowerCase().includes(q)) {
          hits.push({ id: p.id, type: 'page', title: p.title, meta: `page · ${spaceName(p.spaceId)}`, spaceName: spaceName(p.spaceId), href: `/pages/${p.id}` });
        }
      }
      for (const c of this.db.context) {
        if (!inSpace(c.spaceId)) continue;
        if (`${c.statement} ${c.tags.join(' ')}`.toLowerCase().includes(q)) {
          const session = this.db.sessions.find((s) => s.id === c.sessionId);
          hits.push({
            id: c.id,
            type: 'context',
            kind: c.kind,
            title: c.statement,
            meta: `${c.author} · ${session?.title ?? 'session'}`,
            author: c.author,
            spaceName: spaceName(c.spaceId),
            href: `/sessions/${c.sessionId}/context`,
          });
        }
      }
    }
    return hits.slice(0, limit);
  }
}
