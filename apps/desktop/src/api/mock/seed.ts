/**
 * The sample workspace behind "See a demo with sample data". Six teams from the
 * OpenKT knowledge-synthesis report (dwlabs.org/work/openkt-kb) — OpenKT, Sales,
 * Healthcare, Legal, Marketing and Hospitality — each with its sessions from every
 * capture path, the facts people said in them, living pages with forks and
 * changes, and a brief; plus a personal space. You are an owner in some spaces,
 * an editor in others and a reader in one, so access is visible.
 * Timestamps are relative to "now" so "today" and "yesterday" stay true.
 */
import type {
  AccessDefault,
  Connector,
  ContextItem,
  Grant,
  Id,
  ModelSettings,
  Page,
  Person,
  Session,
  Space,
  Team,
  Workspace,
} from '../types';
import { buildShowcase } from './showcase/build';
import { createShowcaseSkills } from './showcase/skills';
import { createSeedSkills, type SeedSkill } from './skills';

function at(daysAgo: number, hh: number, mm: number, now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

export interface SeedData {
  workspace: Workspace;
  spaces: Space[];
  sessions: Session[];
  context: ContextItem[];
  pages: Page[];
  grants: Grant[];
  accessDefaults: AccessDefault[];
  connectors: Connector[];
  skills: SeedSkill[];
  models: ModelSettings;
  /** Which living page each fact feeds (the people panel and the graph). */
  factPage: Record<Id, Id>;
}

const ME: Person = { id: 'u-pratham', name: 'Pratham Bhatnagar', initials: 'PB', email: 'pratham@example.com', title: 'founder' };

/** Settings that live on this Mac whatever the server: shared by the sample and by a real account. */
function deviceSettings(): Pick<SeedData, 'accessDefaults' | 'connectors' | 'models'> {
  const accessDefaults: AccessDefault[] = [
    { id: 'only-me', label: 'Only me' },
    { id: 'space-team-read', label: "The space's team · read" },
    { id: 'filed-space-read', label: 'The space I file it in · read' },
    { id: 'workspace-read', label: 'Everyone in Deepwork · read' },
  ];

  const connectors: Connector[] = [
    { id: 'claude-code', source: 'claude-code', name: 'Claude Code', detail: "sessions follow the folder's space", connected: true, defaultAccess: 'space-team-read' },
    { id: 'codex', source: 'codex', name: 'Codex', detail: "MCP · sessions follow the folder's space", connected: true, defaultAccess: 'space-team-read' },
    { id: 'chatgpt', source: 'chatgpt', name: 'ChatGPT', detail: 'remote MCP · signed in', connected: true, defaultAccess: 'only-me' },
    { id: 'claude', source: 'claude', name: 'Claude', detail: 'claude.ai and Cowork · remote MCP · signed in', connected: true, defaultAccess: 'only-me' },
    { id: 'hermes', source: 'hermes', name: 'Hermes', detail: 'personal agent · access token', connected: true, defaultAccess: 'only-me' },
    { id: 'meetings', source: 'meeting', name: 'Meetings', detail: 'Zoom, Meet, Teams · no bot joins', connected: true, defaultAccess: 'filed-space-read' },
    { id: 'voice', source: 'voice', name: 'Voice and screenshots', detail: 'hold fn · on this Mac', connected: true, defaultAccess: 'filed-space-read' },
    { id: 'notion', source: 'connector', name: 'Notion', detail: 'imports the pages you pick · read-only', connected: true, defaultAccess: 'filed-space-read' },
    { id: 'cursor', source: 'cursor', name: 'Cursor', detail: 'not connected', connected: false, defaultAccess: 'only-me' },
  ];

  const models: ModelSettings = {
    endpoint: '',
    models: [
      { job: 'dictation', jobLabel: 'Dictation', name: 'Parakeet (streaming)', meta: 'streaming · on the Neural Engine', state: 'ready', alternatives: ['Parakeet (streaming)', 'Omnilingual ASR 300M'] },
      { job: 'meetings', jobLabel: 'Meetings', name: 'Omnilingual ASR 300M', meta: '1,600+ languages · Apache-2.0', state: 'ready', alternatives: ['Omnilingual ASR 300M', 'Parakeet (streaming)'] },
      { job: 'understanding', jobLabel: 'Understanding', name: 'Qwen3.5-4B', meta: 'extracts, tags and summarises · 4-bit · 3.0 GB', state: 'ready', alternatives: ['Qwen3.5-4B', 'Qwen3.5-2B'] },
      { job: 'images', jobLabel: 'Images', name: 'Qwen3.5-4B', meta: 'describes screenshots and photos · shared', state: 'ready', alternatives: ['Qwen3.5-4B', 'Qwen3.5-2B'] },
      { job: 'search', jobLabel: 'Search', name: 'Qwen3-Embedding-0.6B', meta: 'must match your server’s index · 0.3 GB', state: { downloading: 62 }, alternatives: ['Qwen3-Embedding-0.6B'] },
      { job: 'reranking', jobLabel: 'Reranking', name: 'Qwen3-Reranker-0.6B', meta: 'orders results for your tools · 0.3 GB', state: 'ready', alternatives: ['Qwen3-Reranker-0.6B'] },
    ],
  };
  return { accessDefaults, connectors, models };
}

/**
 * No workspace content at all: what the HTTP adapter falls back on for the
 * settings a server does not store. A signed-in person never sees sample spaces,
 * sessions, pages or skills.
 */
export function createDeviceSeed(): SeedData {
  return {
    workspace: { id: 'w-device', name: '', me: ME, people: [ME], teams: [] },
    spaces: [],
    sessions: [],
    context: [],
    pages: [],
    grants: [],
    skills: [],
    factPage: {},
    ...deviceSettings(),
  };
}

export function createSeed(now: Date = new Date()): SeedData {
  const when = (d: number, hh: number, mm: number) => at(d, hh, mm, now);
  const me = ME;
  // Teammates who are in the workspace but not yet in any of these spaces: someone to invite.
  const ana: Person = { id: 'u-ana', name: 'Ana Reyes', initials: 'AN', email: 'ana@example.com' };
  const ravi: Person = { id: 'u-ravi', name: 'Ravi Menon', initials: 'RM', email: 'ravi@example.com' };

  const built = buildShowcase(me, when);

  // ── personal: private to you ──
  const followups: Session = {
    id: 's-personal-followups',
    source: 'note',
    title: 'Follow-ups',
    summary: 'Settle the recall return format with Claude. Ask Dr. Ekwueme for edit access to healthcare.',
    status: 'closed',
    spaceId: 'sp-personal',
    authorId: me.id,
    createdAt: when(0, 8, 15),
    extractedOn: 'device',
    turns: [
      { id: 't1', speaker: 'Pratham', at: 0, text: 'Settle the recall return format with Claude: MemMachine-only, or both layers.' },
      { id: 't2', speaker: 'Pratham', at: 0, text: 'Ask Dr. Ekwueme for edit access to healthcare.' },
    ],
  };
  const personalContext: ContextItem[] = [
    { id: 'c-personal-1', kind: 'action', statement: 'Settle the recall return format with Claude', quote: 'Settle the recall return format with Claude', author: 'Pratham', authorId: me.id, sessionId: followups.id, spaceId: 'sp-personal', tags: ['recall'], createdAt: when(0, 8, 16) },
    { id: 'c-personal-2', kind: 'action', statement: 'Ask Dr. Ekwueme for edit access to healthcare', quote: 'Ask Dr. Ekwueme for edit access to healthcare', author: 'Pratham', authorId: me.id, sessionId: followups.id, spaceId: 'sp-personal', tags: ['access'], createdAt: when(0, 8, 16) },
  ];
  const personal: Space = {
    id: 'sp-personal',
    name: 'personal',
    slug: 'personal',
    description: 'Private to you. Nothing is ever dropped for lack of somewhere to put it.',
    personal: true,
    memberCount: 1,
    pageCount: 0,
    sessionCount: 1,
    updatedAt: followups.createdAt,
    ownerId: me.id,
    myRole: 'owner',
  };

  const people = [me, ...built.people, ana, ravi];
  const teams: Team[] = [...built.teams, { id: 't-everyone', name: 'Everyone in Deepwork', memberCount: people.length }];
  const workspace: Workspace = { id: 'w-deepwork', name: 'Deepwork', me, people, teams };

  const subj = (p: Person) => ({ type: 'user' as const, id: p.id, name: p.name, initials: p.initials, email: p.email });
  const byId = (id: Id) => people.find((p) => p.id === id)!;
  const grants: Grant[] = [
    ...built.grants,
    { id: 'g-sp-personal', resource: { type: 'space', id: 'sp-personal' }, subject: subj(me), role: 'owner', note: 'you · only you' },
    { id: 'g-s-personal-followups', resource: { type: 'session', id: followups.id }, subject: subj(me), role: 'owner', note: 'you · saved this session' },
    // Shared directly, on top of what the space gives: someone can edit, someone asked to read.
    { id: 'g-s-sales-acmeflow-marcus', resource: { type: 'session', id: 's-sales-acmeflow' }, subject: subj(byId('u-marcus')), role: 'editor', note: 'added by you' },
    { id: 'g-s-sales-acmeflow-tomas', resource: { type: 'session', id: 's-sales-acmeflow' }, subject: subj(byId('u-tomas')), role: 'reader', note: 'asked for access' },
  ];

  const seededSkills = createSeedSkills((d, hh, mm) => when(d, hh, mm));
  const kbSkills = createShowcaseSkills((d, hh, mm) => when(d, hh, mm), { id: me.id, name: me.name });
  grants.push(...seededSkills.grants, ...kbSkills.grants);

  return {
    workspace,
    spaces: [...built.spaces, personal],
    sessions: [...built.sessions, followups],
    context: [...built.context, ...personalContext],
    pages: built.pages,
    grants,
    skills: [...kbSkills.skills, ...seededSkills.skills],
    factPage: built.factPage,
    ...deviceSettings(),
  };
}
