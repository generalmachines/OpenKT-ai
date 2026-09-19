import type {
  AccessDefault,
  Capabilities,
  Connector,
  ContextItem,
  Grant,
  GrantSubject,
  Id,
  JoinLink,
  Me,
  ModelJob,
  ModelSettings,
  NewFactInput,
  NewSessionInput,
  NewSpaceInput,
  Page,
  PageListItem,
  PreviewArea,
  RecallHit,
  ResourceRef,
  Role,
  Session,
  SessionListItem,
  NewSkillInput,
  SaveSkillInput,
  Skill,
  SkillFile,
  SkillSummary,
  Space,
  SpaceMembers,
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

  /** The signed-in person. */
  getMe(): Promise<Me>;
  getWorkspace(): Promise<Workspace>;

  /** What this server can do beyond the basics. Asked once; a missing route reads as false. */
  capabilities(): Promise<Capabilities>;

  listSpaces(): Promise<Space[]>;
  getSpace(id: Id): Promise<Space>;
  /**
   * A new space owned by the signed-in person, shared with nobody yet. The slug
   * comes from the name; when it is taken the next free `-2`, `-3`… is used.
   */
  createSpace(input: NewSpaceInput): Promise<Space>;
  /** Everyone with access, with their roles. Only the owner sees the whole list; others get what they can piece together. */
  listSpaceMembers(spaceId: Id): Promise<SpaceMembers>;
  /** The newest context saved into a space, each with who saved it. */
  listSpaceContext(spaceId: Id, opts?: { limit?: number }): Promise<ContextItem[]>;
  /** A link anyone can use to join the space as `role`. Owner only. Needs `capabilities().joinLinks`. */
  createJoinLink(spaceId: Id, role: Role): Promise<JoinLink>;
  /** Join with a link or its code; returns the space joined. Needs `capabilities().joinLinks`. */
  joinSpace(linkOrCode: string): Promise<Space>;
  listPages(spaceId: Id): Promise<PageListItem[]>;
  getPage(id: Id): Promise<Page>;

  /** `mine` limits to sessions the signed-in person created (the sidebar). */
  listSessions(filter?: { spaceId?: Id; mine?: boolean }): Promise<SessionListItem[]>;
  getSession(id: Id): Promise<Session>;
  createSession(input: NewSessionInput): Promise<Session>;
  /** File a session (and its context) under another space. Needs `capabilities().moveSession`. */
  moveSession(id: Id, spaceId: Id): Promise<Session>;
  /** `summary` is what the session view shows once closed. */
  closeSession(id: Id, summary?: string): Promise<Session>;
  listContext(sessionId: Id): Promise<ContextItem[]>;
  /** File one fact under a session. */
  saveFact(input: NewFactInput): Promise<ContextItem>;
  deleteFact(id: Id): Promise<void>;

  listGrants(resource: ResourceRef): Promise<Grant[]>;
  /** Share with a person by email. Someone without an account yet comes back `pending`. */
  inviteByEmail(resource: ResourceRef, email: string, role: Role): Promise<Grant>;
  /** Change the role of someone already on the list. */
  putGrant(resource: ResourceRef, subject: GrantSubject, role: Role): Promise<Grant>;
  deleteGrant(resource: ResourceRef, subject: Pick<GrantSubject, 'type' | 'id' | 'email'>): Promise<void>;

  listAccessDefaults(): Promise<AccessDefault[]>;
  listConnectors(): Promise<Connector[]>;
  updateConnector(id: Id, patch: Partial<Pick<Connector, 'defaultAccess' | 'connected'>>): Promise<Connector>;

  /**
   * Skills. Grants on a skill go through `listGrants`/`inviteByEmail`/… with `{type:'skill'}`.
   * Failures are `ApiError`s: `conflict` + code `version_conflict` when someone saved first;
   * `invalid` + one of `SKILL_ERROR_CODES` (src/api/skillFiles.ts) when the files are not a skill.
   */
  listSkills(filter?: { spaceId?: Id; q?: string }): Promise<SkillSummary[]>;
  /** Creates v1 and returns it opened, ready to edit. */
  createSkill(input: NewSkillInput): Promise<Skill>;
  getSkill(id: Id): Promise<Skill>;
  /** The files as they were at version `n`. */
  getSkillVersion(id: Id, version: number): Promise<SkillFile[]>;
  /** Saves the whole file set as a new version. */
  saveSkill(id: Id, input: SaveSkillInput): Promise<Skill>;
  /** Makes version `n` current again, as a new version on top. */
  restoreSkillVersion(id: Id, version: number): Promise<Skill>;
  /** Move to another space, or archive. */
  updateSkill(id: Id, patch: { spaceId?: Id; archived?: boolean }): Promise<SkillSummary>;
  deleteSkill(id: Id): Promise<void>;
  /** Tell the server a run really happened here. Returns the files that ran. Never call it for a run that did not happen. */
  recordSkillRun(id: Id): Promise<SkillFile[]>;

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
