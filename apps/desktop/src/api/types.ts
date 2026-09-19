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
  | 'note'
  | 'codex'
  /** Imported through a connector (a Notion page, a shared doc); `Session.via` names it. */
  | 'connector';

export type SessionStatus = 'open' | 'closed';

/** Fixed set the UI can rely on (architecture.md §2). Tags are free-form. */
export type ContextKind = 'decision' | 'action' | 'fact' | 'question' | 'how-to' | 'idea' | 'issue';

export interface Person {
  id: Id;
  name: string;
  initials: string;
  email?: string;
  /** External people (a customer on a call) are attributed but hold no grants. */
  external?: string;
  /** What they do, as their team would say it: "VP Sales", "Charge Nurse". */
  title?: string;
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
  /** Who made it. */
  ownerId?: Id;
  /** What the signed-in person may do here: an owner shares it, an editor saves into it, a reader only reads. */
  myRole?: Role;
}

/** New space: a name (the slug is made from it), and an optional line about what goes in it. */
export interface NewSpaceInput {
  name: string;
  description?: string;
}

/** Someone with access to a space, as its page lists them. */
export interface SpaceMember {
  id: Id;
  name: string;
  initials: string;
  email?: string;
  /** Unknown when the server does not tell a non-owner who else is in the space. */
  role?: Role;
  /** Invited by email and not signed up yet. */
  pending?: boolean;
  team?: boolean;
  you?: boolean;
}

export interface SpaceMembers {
  members: SpaceMember[];
  /** False when only the owner may see the whole list, and this is what the signed-in person could piece together. */
  complete: boolean;
}

/** A link that lets anyone who has it join a space with `role`. */
export interface JoinLink {
  code: string;
  url: string;
  role: Role;
}

/** What this server can do beyond the basics. A route it does not have reads as false, and the screens hide that control. */
export interface Capabilities {
  /** `PATCH /v1/sessions/:id {project_id}` */
  moveSession: boolean;
  /** `POST /v1/projects/:id/join-links` and `POST /v1/join` */
  joinLinks: boolean;
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
  /** Who saved it, as a name. Empty when the server does not say. */
  authorName?: string;
  createdAt: string;
  /** The app it came through when the source alone does not say: "Cowork", "Notion". */
  via?: string;
  /** Seconds; only meaningful for meetings and voice notes. */
  durationSec?: number;
  /** Where extraction ran. */
  /** Where the context was pulled out: this Mac, the server, or nowhere (saved as written). */
  extractedOn: 'device' | 'server' | 'none';
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
  /** The person who saved it, when known. */
  authorId?: Id;
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

/** A paragraph or a list item of a section written from the server's markdown. */
export interface PageBlock {
  kind: 'p' | 'li';
  spans: PageSpan[];
}

export interface PageSection {
  id: Id;
  heading: string;
  spans: PageSpan[];
  /** A section from the server: paragraphs and list items. When present it is shown instead of `spans`. */
  blocks?: PageBlock[];
  /** The section's markdown with `[^n]` citation markers — what the editor shows. */
  markdown?: string;
  /** A person edited it: agents never rewrite it again (Spec 01 §5 "humans win"). */
  locked?: boolean;
  /** Which fact each `[^n]` of this section stands for, so an edit keeps its citations. */
  citationMap?: { factId: Id; n: number }[];
  /** Two people holding different positions on the same question, each in their own words. Nothing is settled. */
  fork?: PageFork;
  /** What the team believes now, and what it believed before. */
  changes?: PageChange[];
  /** The facts under the page, each with who said it. */
  facts?: PageFact[];
}

export interface PageForkSide {
  who: string;
  position: string;
  cites?: number[];
}

export interface PageFork {
  topic: string;
  sides: PageForkSide[];
  /** Where the disagreement lives, when shown on another page (a space's brief). */
  pageId?: Id;
  pageTitle?: string;
}

export interface PageChange {
  topic: string;
  now: string;
  was: string;
  cites?: number[];
  /** The source of the superseded position. */
  wasCites?: number[];
  pageId?: Id;
  pageTitle?: string;
}

export interface PageFact {
  id: Id;
  kind: ContextKind;
  statement: string;
  author: string;
  cites: number[];
  /** Replaced by a later fact: shown struck through, never deleted. */
  superseded?: boolean;
}

/** Another page this one depends on or feeds, and why. */
export interface PageRelation {
  id: Id;
  title: string;
  why: string;
}

/** Someone whose saved context the page is built from. */
export interface PageContributor {
  name: string;
  title?: string;
  facts: number;
}

export interface PageSource {
  n: number;
  sessionId: Id;
  source: SessionSource;
  title: string;
  /** "Pratham · meeting · today" */
  meta: string;
  /** Who said it: the person whose session it came from. */
  author?: string;
}

/** The space brief (T3): what an AI tool reads first when a session starts in the space. */
export interface SpaceBrief {
  markdown: string;
  updatedAt: string;
}

/** Sessions of a space waiting to become pages. Processing runs on members' Macs with on-device AI. */
export interface SpaceProcessing {
  /** Closed sessions no Mac has picked up yet. */
  waiting: number;
  /** Being processed on a teammate's Mac now. */
  running: number;
  failed: number;
  lastDoneAt: string | null;
  /** Whose Mac did the last one. */
  lastDoneBy: string | null;
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
  related?: PageRelation[];
  contributors?: PageContributor[];
}

export type PageListItem = Pick<Page, 'id' | 'spaceId' | 'title' | 'summary' | 'sessionCount' | 'updatedAt'>;

export type ResourceRef = { type: 'session' | 'space' | 'skill'; id: Id };

export interface GrantSubject {
  type: 'user' | 'team';
  /** Internal key for role changes and removal. Never shown. */
  id: Id;
  /** A person's name; for someone invited who has not joined yet, their email. */
  name: string;
  initials: string;
  email?: string;
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
  /** Invited by email, no account yet: the grant takes effect when they join. */
  pending?: boolean;
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

/** One text file inside a skill. `SKILL.md` is always there; the rest are references it points at. */
export interface SkillFile {
  /** Relative, forward slashes: "SKILL.md", "references/voice.md". */
  path: string;
  content: string;
  bytes: number;
}

export type SkillFileInput = Pick<SkillFile, 'path' | 'content'>;

export interface SkillVersion {
  version: number;
  /** One line from whoever saved it; may be empty. */
  changeNote: string;
  createdBy: { id: Id; name: string };
  createdAt: string;
}

/** A row in the library. */
export interface SkillSummary {
  id: Id;
  /** What connected tools call it: "sharpen-marketing-message". */
  slug: string;
  title: string;
  description: string;
  /** Empty for a skill that lives in nobody's space but the owner's personal one. */
  spaceId: Id;
  spaceName: string;
  owner: { id: Id; name: string };
  currentVersion: number;
  updatedAt: string;
  runCount30d: number;
  /** What the signed-in person may do with it. A skill they cannot read does not exist for them. */
  myRole: Role;
}

/** A skill opened: its current files and its history, newest first. */
export interface Skill extends SkillSummary {
  files: SkillFile[];
  versions: SkillVersion[];
}

export interface NewSkillInput {
  title: string;
  /** None → the personal space. */
  spaceId?: Id;
  /** None → the server writes a starter SKILL.md. */
  files?: SkillFileInput[];
}

export interface SaveSkillInput {
  files: SkillFileInput[];
  changeNote?: string;
  /** The version this edit started from. Someone else saving first makes the save a conflict. */
  baseVersion: number;
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
  /** Who saved it. */
  author?: string;
  /** The space it lives in. */
  spaceName?: string;
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
  /** The whole session as one turn (a note, a voice transcript). */
  text?: string;
  /** Or several turns, in order (a screenshot: caption, description, text in image). Wins over `text`. */
  turns?: string[];
  /** `none`: nothing was extracted on this Mac; the session must not say it was. Default `device`. */
  extractedOn?: 'device' | 'none';
}

/** A person and what they have added to a space: the People panel. */
export interface Contributor {
  personId: Id;
  name: string;
  title?: string;
  initials: string;
  /** Facts they said or saved here. */
  facts: number;
  sessions: number;
  /** The pages their context feeds, most first. */
  topics: { pageId: Id; title: string }[];
}

/** How a space's people, pages and facts connect: the knowledge graph. */
export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface KnowledgeNode {
  id: Id;
  type: 'fact' | 'page' | 'person';
  label: string;
  /** Mono line in the detail panel: the kind and author of a fact, a page's summary, a person's title. */
  detail: string;
  /** Route that opens it. */
  href: string;
  kind?: ContextKind;
  /** Page this fact feeds (colour grouping). */
  pageId?: Id;
  /** Who said this fact. */
  personId?: Id;
  superseded?: boolean;
}

export interface KnowledgeEdge {
  from: Id;
  to: Id;
  type: 'feeds' | 'contributes' | 'relates';
  /** Why two pages are related. */
  label?: string;
}
