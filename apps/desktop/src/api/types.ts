/**
 * Domain types. These mirror the server concepts in docs/product.md and
 * docs/architecture.md (workspace, space, session, fact/context, page, grant,
 * connector, skill, model). The renderer only ever sees these shapes — never
 * an adapter's wire format.
 */

export type Id = string;

export type Role = 'reader' | 'editor' | 'owner';
export const ROLES: readonly Role[] = ['reader', 'editor', 'owner'];

/** Where a session came from. Drives the icon and the mono meta line. */
export type SessionSource =
  | 'meeting'
  | 'claude-code'
  | 'cursor'
  | 'chatgpt'
  | 'claude'
  | 'hermes'
  | 'voice'
  | 'screenshot'
  | 'note';

export type SessionStatus = 'open' | 'closed';

/** Fixed set the UI can rely on (architecture.md §2). Tags are free-form. */
export type ContextKind = 'decision' | 'action' | 'fact' | 'question' | 'how-to' | 'idea' | 'issue';

export interface Person {
  id: Id;
  name: string;
  initials: string;
  /** External people (a customer on a call) are attributed but hold no grants. */
  external?: string;
}

export interface Team {
  id: Id;
  name: string;
  memberCount: number;
}

export interface Workspace {
  id: Id;
  name: string;
  me: Person;
  people: Person[];
  teams: Team[];
}

export interface Space {
  id: Id;
  /** Display name, e.g. "sales / northgate". */
  name: string;
  /** Short label used in session meta lines, e.g. "sales". */
  slug: string;
  description: string;
  personal?: boolean;
  memberCount: number;
  pageCount: number;
  sessionCount: number;
  /** ISO timestamp of the last change to any page or session. */
  updatedAt: string;
}

export interface Turn {
  id: Id;
  speaker: string;
  /** Offset from the start of the session, in seconds. */
  at: number;
  text: string;
}

export interface Session {
  id: Id;
  source: SessionSource;
  title: string;
  summary: string;
  status: SessionStatus;
  spaceId: Id;
  authorId: Id;
  createdAt: string;
  /** Seconds; only meaningful for meetings and voice notes. */
  durationSec?: number;
  /** Where extraction ran. */
  extractedOn: 'device' | 'server';
  turns: Turn[];
}

export type SessionListItem = Omit<Session, 'turns'>;

/** T1 fact. Immutable on the server: superseded, never edited. */
export interface ContextItem {
  id: Id;
  kind: ContextKind;
  statement: string;
  /** Verbatim quote that must be found in the session (the quote gate). */
  quote?: string;
  /** Attribution as shown: people who said it, or "open" for questions. */
  author: string;
  sessionId: Id;
  spaceId: Id;
  tags: string[];
  createdAt: string;
  supersededBy?: Id;
}

/** One run of text inside a page section. */
export interface PageSpan {
  text: string;
  struck?: boolean;
  cites?: number[];
}

export interface PageSection {
  id: Id;
  heading: string;
  spans: PageSpan[];
}

export interface PageSource {
  n: number;
  sessionId: Id;
  source: SessionSource;
  title: string;
  /** "Pratham · meeting · today" */
  meta: string;
}

export interface Page {
  id: Id;
  spaceId: Id;
  title: string;
  summary: string;
  sessionCount: number;
  updatedAt: string;
  sections: PageSection[];
  citations: PageSource[];
  reach: string;
}

export type PageListItem = Pick<Page, 'id' | 'spaceId' | 'title' | 'summary' | 'sessionCount' | 'updatedAt'>;

export type ResourceRef = { type: 'session' | 'space'; id: Id };

export interface GrantSubject {
  type: 'user' | 'team';
  id: Id;
  name: string;
  initials: string;
}

export interface Grant {
  id: Id;
  resource: ResourceRef;
  subject: GrantSubject;
  role: Role;
  /** Mono line under the name: "added by you", "6 people · inherited from …". */
  note: string;
  /** Inherited grants come from the space and cannot be removed here. */
  inherited?: boolean;
}

export interface AccessDefault {
  id: Id;
  label: string;
}

export interface Connector {
  id: Id;
  source: SessionSource;
  name: string;
  detail: string;
  connected: boolean;
  /** AccessDefault.id */
  defaultAccess: Id;
}

export interface Skill {
  id: Id;
  name: string;
  description: string;
  /** "v4 · used 31 times this month" */
  meta: string;
  /** "marketing · sales" | "only me" */
  sharedWith: string;
  version: number;
}

export interface SkillRun {
  skillId: Id;
  output: string;
  model: string;
}

export type ModelJob = 'dictation' | 'meetings' | 'understanding' | 'images' | 'search' | 'reranking';

export interface LocalModel {
  job: ModelJob;
  jobLabel: string;
  name: string;
  meta: string;
  /** 'ready', or download progress 0–100. */
  state: 'ready' | { downloading: number };
  alternatives: string[];
}

export interface ModelSettings {
  models: LocalModel[];
  /** Any OpenAI-compatible URL; empty means in-process inference. */
  endpoint: string;
}

export interface RecallHit {
  id: Id;
  type: 'session' | 'context' | 'page';
  title: string;
  meta: string;
  kind?: ContextKind;
  source?: SessionSource;
  /** Route inside the app. */
  href: string;
}

/** The signed-in person, as the server knows them (`GET /v1/me`). */
export interface Me {
  id: Id;
  name: string;
  email: string;
  initials: string;
}

/** A fact the client extracted (or the user wrote) and files under a session. */
export interface NewFactInput {
  sessionId: Id;
  spaceId: Id;
  statement: string;
  kind?: ContextKind;
}

/** Parts of the product an adapter serves from sample data, so screens can say so. */
export type PreviewArea = 'pages' | 'skills' | 'connectors' | 'access-defaults' | 'models' | 'teams';

export interface NewSessionInput {
  source: SessionSource;
  title: string;
  spaceId: Id;
  text?: string;
}
