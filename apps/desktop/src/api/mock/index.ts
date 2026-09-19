import { NotFoundError, type OpenKTClient } from '../client';
import type {
  Connector,
  ContextItem,
  Grant,
  GrantSubject,
  Id,
  ModelJob,
  ModelSettings,
  NewFactInput,
  NewSessionInput,
  RecallHit,
  ResourceRef,
  Role,
  Session,
  SessionListItem,
  Skill,
} from '../types';
import { sourceLabel } from '../format';
import { createSeed, type SeedData } from './seed';

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

  constructor(seed: SeedData = createSeed()) {
    this.db = seed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    return { id: me.id, name: me.name, initials: me.initials, email: `${me.name.split(' ')[0]?.toLowerCase() ?? 'me'}@example.com` };
  }

  async getWorkspace() {
    return clone(this.db.workspace);
  }

  async listSpaces() {
    return clone(this.db.spaces);
  }

  async getSpace(id: Id) {
    const s = this.db.spaces.find((x) => x.id === id);
    if (!s) throw new NotFoundError('space', id);
    return clone(s);
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

  async listSessions(filter?: { spaceId?: Id; mine?: boolean }) {
    const me = this.db.workspace.me.id;
    return this.db.sessions
      .filter((s) => (filter?.spaceId ? s.spaceId === filter.spaceId : true))
      .filter((s) => (filter?.mine ? s.authorId === me : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => clone(stripTurns(s)));
  }

  async getSession(id: Id) {
    const s = this.db.sessions.find((x) => x.id === id);
    if (!s) throw new NotFoundError('session', id);
    return clone(s);
  }

  async createSession(input: NewSessionInput) {
    const me = this.db.workspace.me;
    const id = this.nextId('s');
    const text = input.text?.trim() ?? '';
    const session: Session = {
      id,
      source: input.source,
      title: input.title.trim() || 'Untitled note',
      summary: text,
      status: 'open',
      spaceId: input.spaceId,
      authorId: me.id,
      createdAt: new Date().toISOString(),
      extractedOn: 'device',
      turns: text ? [{ id: 't1', speaker: me.name.split(' ')[0] ?? me.name, at: 0, text }] : [],
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

  async deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id'>): Promise<void> {
    this.db.grants = this.db.grants.filter(
      (g) => !(sameResource(g.resource, resource) && g.subject.type === subject.type && g.subject.id === subject.id),
    );
    this.changed();
  }

  async searchSubjects(query: string): Promise<GrantSubject[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const people: GrantSubject[] = this.db.workspace.people
      .filter((p) => !p.external)
      .map((p) => ({ type: 'user', id: p.id, name: p.name, initials: p.initials }));
    const teams: GrantSubject[] = this.db.workspace.teams.map((t) => ({
      type: 'team',
      id: t.id,
      name: t.name,
      initials: t.name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
    }));
    return [...people, ...teams].filter((s) => s.name.toLowerCase().includes(q));
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

  async listSkills() {
    return clone(this.db.skills);
  }

  async createSkill(name: string): Promise<Skill> {
    const skill: Skill = {
      id: this.nextId('sk'),
      name: name.trim() || 'Untitled skill',
      description: 'Describe what this skill does and which space it should pull context from.',
      meta: 'v1 · draft',
      sharedWith: 'only me',
      version: 1,
    };
    this.db.skills.push(skill);
    this.changed();
    return clone(skill);
  }

  async runSkill(id: Id) {
    const s = this.db.skills.find((x) => x.id === id);
    if (!s) throw new NotFoundError('skill', id);
    const understanding = this.db.models.models.find((m) => m.job === 'understanding');
    await new Promise((r) => setTimeout(r, 600));
    return {
      skillId: id,
      model: understanding?.name ?? 'local model',
      output: `Simulated run of “${s.name}”. The Swift engine is not attached, so no model ran.`,
    };
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
          href: `/sessions/${s.id}`,
        });
      }
    }
    if (q) {
      for (const p of this.db.pages) {
        if (!inSpace(p.spaceId)) continue;
        if (`${p.title} ${p.summary}`.toLowerCase().includes(q)) {
          hits.push({ id: p.id, type: 'page', title: p.title, meta: `page · ${spaceName(p.spaceId)}`, href: `/pages/${p.id}` });
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
            href: `/sessions/${c.sessionId}/context`,
          });
        }
      }
    }
    return hits.slice(0, limit);
  }
}
