import type {
  AccessDefault,
  Connector,
  ContextItem,
  Grant,
  GrantSubject,
  Id,
  Me,
  ModelJob,
  ModelSettings,
  NewFactInput,
  NewSessionInput,
  Page,
  PageListItem,
  PreviewArea,
  RecallHit,
  ResourceRef,
  Role,
  Session,
  SessionListItem,
  Skill,
  SkillRun,
  Space,
  Workspace,
} from './types';

/**
 * The one interface the renderer talks to. Two adapters implement it:
 *   - mock  (src/api/mock)  in-memory, seeded from the design canvas
 *   - http  (src/api/http)  thin fetch client against the OpenKT server
 *
 * Every method is async so the two are interchangeable. Mutations notify
 * subscribers; `useQuery` re-reads when that happens.
 */
export interface OpenKTClient {
  readonly kind: 'mock' | 'http';

  /** Called after any mutation. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Tell subscribers to re-read: something changed outside this client (a capture filed from an overlay window). */
  refresh(): void;

  /** Areas this adapter fills with sample data because the server has no endpoint yet. */
  readonly preview: ReadonlySet<PreviewArea>;

  /** Who the token belongs to. The Connect screen's "Test connection". */
  getMe(): Promise<Me>;
  getWorkspace(): Promise<Workspace>;

  listSpaces(): Promise<Space[]>;
  getSpace(id: Id): Promise<Space>;
  listPages(spaceId: Id): Promise<PageListItem[]>;
  getPage(id: Id): Promise<Page>;

  /** `mine` limits to sessions the signed-in person created (the sidebar). */
  listSessions(filter?: { spaceId?: Id; mine?: boolean }): Promise<SessionListItem[]>;
  getSession(id: Id): Promise<Session>;
  createSession(input: NewSessionInput): Promise<Session>;
  /** `summary` is what the session view shows once closed. */
  closeSession(id: Id, summary?: string): Promise<Session>;
  listContext(sessionId: Id): Promise<ContextItem[]>;
  /** File one fact under a session. */
  saveFact(input: NewFactInput): Promise<ContextItem>;
  deleteFact(id: Id): Promise<void>;

  listGrants(resource: ResourceRef): Promise<Grant[]>;
  putGrant(resource: ResourceRef, subject: GrantSubject, role: Role): Promise<Grant>;
  deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id'>): Promise<void>;
  /** People and teams that can be invited (used by the Access tab input). */
  searchSubjects(query: string): Promise<GrantSubject[]>;

  listAccessDefaults(): Promise<AccessDefault[]>;
  listConnectors(): Promise<Connector[]>;
  updateConnector(id: Id, patch: Partial<Pick<Connector, 'defaultAccess' | 'connected'>>): Promise<Connector>;

  listSkills(): Promise<Skill[]>;
  createSkill(name: string): Promise<Skill>;
  runSkill(id: Id): Promise<SkillRun>;

  getModelSettings(): Promise<ModelSettings>;
  setModel(job: ModelJob, name: string): Promise<ModelSettings>;
  setModelEndpoint(endpoint: string): Promise<ModelSettings>;

  recall(query: string, opts?: { spaceId?: Id; limit?: number }): Promise<RecallHit[]>;
}

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}
