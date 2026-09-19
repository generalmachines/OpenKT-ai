/**
 * Seed data for the mock adapter. Content is taken from the design canvas
 * (design/canvas/*.dc.html) so the running app reads like the approved mocks.
 * Timestamps are relative to "now" so "today" and "yesterday" stay true.
 */
import type {
  AccessDefault,
  Connector,
  ContextItem,
  Grant,
  ModelSettings,
  Page,
  Person,
  Session,
  Skill,
  Space,
  Team,
  Workspace,
} from '../types';

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
  skills: Skill[];
  models: ModelSettings;
}

export function createSeed(now: Date = new Date()): SeedData {
  const me: Person = { id: 'u-pratham', name: 'Pratham Bhatnagar', initials: 'PB', email: 'pratham@example.com' };
  const ana: Person = { id: 'u-ana', name: 'Ana Reyes', initials: 'AN', email: 'ana@example.com' };
  const ravi: Person = { id: 'u-ravi', name: 'Ravi Menon', initials: 'RM', email: 'ravi@example.com' };
  const ojas: Person = { id: 'u-ojas', name: 'Ojas Sinha', initials: 'OS', email: 'ojas@example.com' };
  const lena: Person = { id: 'u-lena', name: 'Lena Fischer', initials: 'LF', email: 'lena@example.com' };
  const marcus: Person = { id: 'x-marcus', name: 'Marcus', initials: 'MA', external: 'Northgate' };

  const teams: Team[] = [
    { id: 't-sales', name: 'Sales team', memberCount: 6 },
    { id: 't-eng', name: 'Engineering', memberCount: 5 },
    { id: 't-marketing', name: 'Marketing', memberCount: 3 },
    { id: 't-founders', name: 'Founders', memberCount: 2 },
    { id: 't-everyone', name: 'Everyone in Deepwork', memberCount: 14 },
  ];

  const workspace: Workspace = {
    id: 'w-deepwork',
    name: 'Deepwork',
    me,
    people: [me, ana, ravi, ojas, lena, marcus],
    teams,
  };

  const spaces: Space[] = [
    {
      id: 'sp-northgate',
      name: 'sales / northgate',
      slug: 'sales',
      description: 'Everything about the Northgate deal: pricing, people, stores and systems.',
      memberCount: 7,
      pageCount: 4,
      sessionCount: 4,
      updatedAt: at(0, 10, 48, now),
    },
    {
      id: 'sp-openkt',
      name: 'engineering / openkt',
      slug: 'openkt',
      description: 'Decisions and gotchas for the OpenKT server and clients.',
      memberCount: 5,
      pageCount: 9,
      sessionCount: 31,
      updatedAt: at(0, 9, 12, now),
    },
    {
      id: 'sp-marketing',
      name: 'marketing',
      slug: 'marketing',
      description: 'Positioning, launch messaging and the team voice.',
      memberCount: 3,
      pageCount: 5,
      sessionCount: 12,
      updatedAt: at(1, 16, 30, now),
    },
    {
      id: 'sp-ideas',
      name: 'ideas',
      slug: 'ideas',
      description: 'Thoughts said out loud, merged with earlier thinking on the same theme.',
      memberCount: 14,
      pageCount: 6,
      sessionCount: 18,
      updatedAt: at(0, 8, 41, now),
    },
    {
      id: 'sp-founders',
      name: 'founders',
      slug: 'founders',
      description: 'Hiring, runway and planning. Two people.',
      memberCount: 2,
      pageCount: 3,
      sessionCount: 7,
      updatedAt: at(1, 11, 5, now),
    },
    {
      id: 'sp-personal',
      name: 'personal',
      slug: 'personal',
      description: 'Private to you. Nothing is ever dropped for lack of somewhere to put it.',
      personal: true,
      memberCount: 1,
      pageCount: 2,
      sessionCount: 22,
      updatedAt: at(1, 18, 20, now),
    },
  ];

  const sessions: Session[] = [
    {
      id: 's-northgate-pricing',
      source: 'meeting',
      title: 'Pricing call with Northgate',
      summary:
        'Northgate wants pricing per store, not per seat. They run fourteen stores, three still on the legacy POS, and want those three included from day one. No decision yet — they meet internally on Friday. Ana owns the revised quote.',
      status: 'closed',
      spaceId: 'sp-northgate',
      authorId: me.id,
      createdAt: at(0, 10, 2, now),
      durationSec: 42 * 60,
      extractedOn: 'device',
      turns: [
        { id: 't1', speaker: 'Pratham', at: 12, text: 'Thanks for making time, Marcus. Ana and Ravi are on as well. We wanted to walk through the quote and hear what is not working for you.' },
        { id: 't2', speaker: 'Marcus (Northgate)', at: 41, text: 'Sure. The short version is that per-seat pricing does not fit how we run. Staff rotate between stores, seasonal people come and go. We think in stores, not seats.' },
        { id: 't3', speaker: 'Ana', at: 88, text: 'That makes sense. How many stores are we talking about today?' },
        { id: 't4', speaker: 'Marcus (Northgate)', at: 101, text: 'Fourteen. Three of them are still on the legacy POS, and I want those three included from day one — they are the ones that need it most.' },
        { id: 't5', speaker: 'Ravi', at: 164, text: 'Can the legacy POS export daily sales as CSV? That decides how much work those three are.' },
        { id: 't6', speaker: 'Marcus (Northgate)', at: 179, text: 'I believe so but I would have to check with our IT contractor. Put it down as an open question.' },
        { id: 't7', speaker: 'Pratham', at: 1320, text: 'Then let us quote per store, not per seat. Ana, can you turn that around this week?' },
        { id: 't8', speaker: 'Ana', at: 1334, text: 'Yes. I will send the revised quote before Friday.' },
        { id: 't9', speaker: 'Marcus (Northgate)', at: 1712, text: 'One more thing — our procurement needs a security one-pager before any trial. Nothing long, but they will not move without it.' },
        { id: 't10', speaker: 'Marcus (Northgate)', at: 2388, text: 'We meet internally on Friday. No decision before then, but this is heading the right way.' },
      ],
    },
    {
      id: 's-auth-refresh',
      source: 'claude-code',
      title: 'Fix auth refresh storm',
      summary:
        'Every open tab refreshed its token at the same moment after a deploy, and the auth service rate-limited the whole team. The fix adds jitter to the refresh timer and a single-flight lock per browser profile. Deployed to staging; production follows after a day of clean logs.',
      status: 'closed',
      spaceId: 'sp-openkt',
      authorId: me.id,
      createdAt: at(0, 9, 12, now),
      extractedOn: 'server',
      turns: [
        { id: 't1', speaker: 'Pratham', at: 0, text: 'After the deploy every tab hits /auth/refresh in the same second and we get 429s. Find where the timer is set.' },
        { id: 't2', speaker: 'Claude Code', at: 38, text: 'The timer is set in useSession.ts from the token expiry with no jitter, so all tabs that loaded the same token fire together. I can add ±20% jitter and a BroadcastChannel single-flight lock.' },
        { id: 't3', speaker: 'Pratham', at: 95, text: 'Do both. Staging uses port 8443 for auth, not 443 — check the e2e config.' },
        { id: 't4', speaker: 'Claude Code', at: 412, text: 'Done. Tests pass, and the e2e suite now reads the auth port from the environment.' },
      ],
    },
    {
      id: 's-onboarding-kit',
      source: 'voice',
      title: 'Idea: per-store onboarding kit',
      summary:
        'What if every new store got an onboarding kit — a printed shelf map, the first week’s planogram, and a QR code to the floor plan. It would make the first week feel finished instead of half set up.',
      status: 'closed',
      spaceId: 'sp-ideas',
      authorId: me.id,
      createdAt: at(0, 8, 41, now),
      durationSec: 47,
      extractedOn: 'device',
      turns: [
        { id: 't1', speaker: 'Pratham', at: 0, text: 'What if every new store got an onboarding kit — a printed shelf map, the first week’s planogram, and a QR code to the floor plan. The first week should feel finished, not half set up.' },
      ],
    },
    {
      id: 's-q4-messaging',
      source: 'chatgpt',
      title: 'Q4 launch messaging',
      summary:
        'Worked the launch headline down to one claim: your team’s context, in every tool. Dropped “AI memory” from the copy — it reads as a personal feature. The comparison table moves below the fold.',
      status: 'closed',
      spaceId: 'sp-marketing',
      authorId: me.id,
      createdAt: at(1, 18, 20, now),
      extractedOn: 'server',
      turns: [
        { id: 't1', speaker: 'Pratham', at: 0, text: 'Here is the draft headline and three alternatives. Which one makes a single claim?' },
        { id: 't2', speaker: 'ChatGPT', at: 22, text: 'The second — “Your team’s context, in every tool” — makes one claim and avoids superlatives. “AI memory” tends to read as a personal feature.' },
      ],
    },
    {
      id: 's-inbox-triage',
      source: 'hermes',
      title: 'Inbox triage',
      summary:
        'Hermes sorted 46 messages: four need a reply today, two are invoices, the rest are archived. Northgate’s procurement contact asked for the security one-pager again.',
      status: 'closed',
      spaceId: 'sp-personal',
      authorId: me.id,
      createdAt: at(1, 16, 30, now),
      extractedOn: 'server',
      turns: [
        { id: 't1', speaker: 'Hermes', at: 0, text: 'Sorted 46 messages. Four need a reply today. Two invoices were forwarded to accounting.' },
      ],
    },
    {
      id: 's-competitor-pricing',
      source: 'screenshot',
      title: 'Competitor pricing page',
      summary:
        'Competitor pricing page — three tiers, per-store billing on the top tier only. The middle tier is per seat with a 25-seat minimum.',
      status: 'closed',
      spaceId: 'sp-northgate',
      authorId: me.id,
      createdAt: at(1, 14, 7, now),
      extractedOn: 'device',
      turns: [
        { id: 't1', speaker: 'On-screen text', at: 0, text: 'Starter · Growth · Enterprise. Enterprise: billed per store, unlimited seats. Growth: per seat, 25-seat minimum.' },
      ],
    },
    {
      id: 's-hiring-plan',
      source: 'note',
      title: 'Hiring plan notes',
      summary:
        'Two hires before the end of the year: a forward-deployed engineer first, then a designer on contract. No sales hire until three customers renew.',
      status: 'closed',
      spaceId: 'sp-founders',
      authorId: me.id,
      createdAt: at(1, 11, 5, now),
      extractedOn: 'device',
      turns: [
        { id: 't1', speaker: 'Pratham', at: 0, text: 'Two hires before year end. Forward-deployed engineer first, designer on contract second. No sales hire until three customers renew.' },
      ],
    },
    {
      id: 's-draft-proposal',
      source: 'chatgpt',
      title: 'Draft proposal v1',
      summary: 'First proposal for Northgate: per-seat pricing with a volume discount above 40 seats. Superseded by the per-store quote.',
      status: 'closed',
      spaceId: 'sp-northgate',
      authorId: ana.id,
      createdAt: at(8, 15, 40, now),
      extractedOn: 'server',
      turns: [{ id: 't1', speaker: 'Ana', at: 0, text: 'Draft a proposal for Northgate using per-seat pricing with a volume discount above 40 seats.' }],
    },
    {
      id: 's-intro-call',
      source: 'note',
      title: 'Intro call notes',
      summary: 'Marcus leads operations at Northgate. Procurement signs off after a security review; they need a one-pager before any trial.',
      status: 'closed',
      spaceId: 'sp-northgate',
      authorId: ravi.id,
      createdAt: at(15, 11, 0, now),
      extractedOn: 'server',
      turns: [{ id: 't1', speaker: 'Ravi', at: 0, text: 'Marcus leads operations. Procurement signs off after a security review. They need a security one-pager before any trial.' }],
    },
  ];

  const ctx = (
    id: string,
    sessionId: string,
    spaceId: string,
    kind: ContextItem['kind'],
    statement: string,
    author: string,
    quote: string,
    tags: string[],
    createdAt: string,
  ): ContextItem => ({ id, sessionId, spaceId, kind, statement, author, quote, tags, createdAt });

  const t0 = at(0, 10, 48, now);
  const context: ContextItem[] = [
    ctx('c-ng-1', 's-northgate-pricing', 'sp-northgate', 'decision', 'Quote Northgate per store, not per seat', 'Ana, Ravi', 'Then let us quote per store, not per seat.', ['pricing', 'northgate'], t0),
    ctx('c-ng-2', 's-northgate-pricing', 'sp-northgate', 'action', 'Ana sends the revised quote before Friday', 'Ana', 'I will send the revised quote before Friday.', ['pricing', 'quote'], t0),
    ctx('c-ng-3', 's-northgate-pricing', 'sp-northgate', 'fact', 'Northgate runs 14 stores, 3 still on the legacy POS', 'Marcus (Northgate)', 'Fourteen. Three of them are still on the legacy POS', ['stores', 'pos'], t0),
    ctx('c-ng-4', 's-northgate-pricing', 'sp-northgate', 'question', 'Can the legacy POS export daily sales as CSV?', 'open', 'Can the legacy POS export daily sales as CSV?', ['pos', 'data'], t0),
    ctx('c-ng-5', 's-northgate-pricing', 'sp-northgate', 'how-to', 'Their procurement needs a security one-pager before any trial', 'Marcus (Northgate)', 'our procurement needs a security one-pager before any trial', ['procurement', 'security'], t0),
    ctx('c-ng-6', 's-northgate-pricing', 'sp-northgate', 'fact', 'Northgate meets internally on Friday; no decision before then', 'Marcus (Northgate)', 'We meet internally on Friday. No decision before then', ['timeline'], t0),

    ctx('c-au-1', 's-auth-refresh', 'sp-openkt', 'decision', 'Token refresh gets ±20% jitter and a single-flight lock per browser profile', 'Pratham', 'I can add ±20% jitter and a BroadcastChannel single-flight lock.', ['auth', 'refresh'], at(0, 9, 30, now)),
    ctx('c-au-2', 's-auth-refresh', 'sp-openkt', 'fact', 'Staging serves auth on port 8443, not 443', 'Pratham', 'Staging uses port 8443 for auth, not 443', ['staging', 'auth'], at(0, 9, 30, now)),
    ctx('c-au-3', 's-auth-refresh', 'sp-openkt', 'action', 'Promote the refresh fix to production after a day of clean staging logs', 'Pratham', 'Tests pass, and the e2e suite now reads the auth port from the environment.', ['deploy'], at(0, 9, 30, now)),

    ctx('c-ok-1', 's-onboarding-kit', 'sp-ideas', 'idea', 'Give every new store an onboarding kit: shelf map, first week’s planogram, QR code to the floor plan', 'Pratham', 'What if every new store got an onboarding kit', ['onboarding', 'stores'], at(0, 8, 42, now)),

    ctx('c-q4-1', 's-q4-messaging', 'sp-marketing', 'decision', 'Launch headline: “Your team’s context, in every tool”', 'Pratham', 'makes one claim and avoids superlatives', ['launch', 'headline'], at(1, 16, 50, now)),
    ctx('c-q4-2', 's-q4-messaging', 'sp-marketing', 'how-to', 'Do not say “AI memory” in copy — it reads as a personal feature', 'Pratham', '“AI memory” tends to read as a personal feature', ['voice'], at(1, 16, 50, now)),

    ctx('c-in-1', 's-inbox-triage', 'sp-personal', 'action', 'Reply to four messages flagged for today', 'Hermes', 'Four need a reply today.', ['inbox'], at(1, 18, 21, now)),

    ctx('c-cp-1', 's-competitor-pricing', 'sp-northgate', 'fact', 'Competitor bills per store only on the top tier; the middle tier is per seat with a 25-seat minimum', 'Pratham', 'Enterprise: billed per store, unlimited seats.', ['pricing', 'competitors'], at(1, 14, 8, now)),

    ctx('c-hp-1', 's-hiring-plan', 'sp-founders', 'decision', 'Hire a forward-deployed engineer first, then a designer on contract', 'Pratham', 'Forward-deployed engineer first, designer on contract second.', ['hiring'], at(1, 11, 6, now)),
    ctx('c-hp-2', 's-hiring-plan', 'sp-founders', 'decision', 'No sales hire until three customers renew', 'Pratham', 'No sales hire until three customers renew.', ['hiring', 'sales'], at(1, 11, 6, now)),

    ctx('c-dp-1', 's-draft-proposal', 'sp-northgate', 'decision', 'Per-seat pricing with a volume discount above 40 seats', 'Ana', 'per-seat pricing with a volume discount above 40 seats', ['pricing'], at(8, 15, 45, now)),
    ctx('c-ic-1', 's-intro-call', 'sp-northgate', 'fact', 'Marcus leads operations; procurement signs off after a security review', 'Ravi', 'Procurement signs off after a security review.', ['people', 'procurement'], at(15, 11, 5, now)),
  ];
  const superseded = context.find((c) => c.id === 'c-dp-1');
  if (superseded) superseded.supersededBy = 'c-ng-1';

  const northgateSources = [
    { n: 1, sessionId: 's-northgate-pricing', source: 'meeting' as const, title: 'Pricing call with Northgate', meta: 'Pratham · meeting · today' },
    { n: 2, sessionId: 's-draft-proposal', source: 'chatgpt' as const, title: 'Draft proposal v1', meta: 'Ana · chatgpt · 11 Sep' },
    { n: 3, sessionId: 's-intro-call', source: 'note' as const, title: 'Intro call notes', meta: 'Ravi · note · 4 Sep' },
    { n: 4, sessionId: 's-competitor-pricing', source: 'screenshot' as const, title: 'Competitor pricing page', meta: 'Pratham · screenshot · yesterday' },
  ];

  const pages: Page[] = [
    {
      id: 'p-northgate-pricing',
      spaceId: 'sp-northgate',
      title: 'Northgate — pricing',
      summary: 'Per-store pricing requested; revised quote due Friday. Supersedes the per-seat proposal.',
      sessionCount: 4,
      updatedAt: at(0, 10, 48, now),
      sections: [
        {
          id: 'sec-stands',
          heading: 'Where it stands',
          spans: [
            { text: 'Northgate wants to be priced per store, not per seat', cites: [1] },
            { text: '. They run fourteen stores, three on a legacy POS, and want all fourteen included from the start', cites: [1] },
            { text: '. A revised quote is due before their internal meeting on Friday; Ana owns it', cites: [1] },
            { text: '.' },
          ],
        },
        {
          id: 'sec-changed',
          heading: 'What changed',
          spans: [
            { text: 'Per-seat pricing with a volume discount above 40 seats', struck: true, cites: [2] },
            { text: ' — replaced today by per-store pricing', cites: [1] },
            { text: '.' },
          ],
        },
        {
          id: 'sec-open',
          heading: 'Open',
          spans: [
            { text: 'Whether the legacy POS can export daily sales as CSV', cites: [1] },
            { text: '. Procurement needs a security one-pager before any trial', cites: [3] },
            { text: '.' },
          ],
        },
      ],
      citations: northgateSources,
      reach: 'Used in 6 sessions by 3 teammates this week.',
    },
    {
      id: 'p-northgate-people',
      spaceId: 'sp-northgate',
      title: 'Northgate — people and process',
      summary: 'Marcus leads operations; procurement signs off after a security review.',
      sessionCount: 3,
      updatedAt: at(15, 11, 5, now),
      sections: [
        {
          id: 'sec-people',
          heading: 'Who decides',
          spans: [
            { text: 'Marcus leads operations and is the day-to-day contact', cites: [2] },
            { text: '. Procurement signs off after a security review and needs a one-pager before any trial', cites: [1, 2] },
            { text: '.' },
          ],
        },
        {
          id: 'sec-process',
          heading: 'How they buy',
          spans: [{ text: 'They meet internally on Fridays; decisions are not made on calls', cites: [1] }, { text: '.' }],
        },
      ],
      citations: [northgateSources[0]!, { ...northgateSources[2]!, n: 2 }],
      reach: 'Used in 2 sessions by 2 teammates this week.',
    },
    {
      id: 'p-northgate-stores',
      spaceId: 'sp-northgate',
      title: 'Northgate — stores and systems',
      summary: 'Fourteen stores, three on a legacy POS. Daily sales export still unconfirmed.',
      sessionCount: 2,
      updatedAt: at(0, 10, 48, now),
      sections: [
        {
          id: 'sec-stores',
          heading: 'Stores',
          spans: [{ text: 'Fourteen stores. Three still run the legacy POS and must be included from day one', cites: [1] }, { text: '.' }],
        },
        {
          id: 'sec-open',
          heading: 'Open',
          spans: [{ text: 'Whether the legacy POS can export daily sales as CSV — Marcus is checking with their IT contractor', cites: [1] }, { text: '.' }],
        },
      ],
      citations: [northgateSources[0]!],
      reach: 'Used in 3 sessions by 2 teammates this week.',
    },
    {
      id: 'p-retail-pricing',
      spaceId: 'sp-northgate',
      title: 'Retail pricing — what competitors charge',
      summary: 'Three-tier pages are the norm; per-store billing appears only on top tiers.',
      sessionCount: 1,
      updatedAt: at(1, 14, 8, now),
      sections: [
        {
          id: 'sec-tiers',
          heading: 'What we have seen',
          spans: [
            { text: 'Three tiers are the norm. Per-store billing appears only on the top tier; the middle tier is per seat with a 25-seat minimum', cites: [1] },
            { text: '.' },
          ],
        },
      ],
      citations: [{ ...northgateSources[3]!, n: 1 }],
      reach: 'Used in 1 session this week.',
    },
  ];

  const subj = (p: Person) => ({ type: 'user' as const, id: p.id, name: p.name, initials: p.initials, email: p.email });
  const pricing = { type: 'session' as const, id: 's-northgate-pricing' };
  const grants: Grant[] = [
    { id: 'g-1', resource: pricing, subject: subj(me), role: 'owner', note: 'you · recorded this session' },
    {
      id: 'g-2',
      resource: pricing,
      subject: { type: 'team', id: 't-sales', name: 'Sales team', initials: 'ST' },
      role: 'reader',
      note: '6 people · inherited from space sales / northgate',
      inherited: true,
    },
    { id: 'g-3', resource: pricing, subject: subj(ana), role: 'editor', note: 'added by you' },
    { id: 'g-4', resource: pricing, subject: subj(ojas), role: 'reader', note: 'engineering · asked for access' },

    { id: 'g-sp-1', resource: { type: 'space', id: 'sp-northgate' }, subject: subj(me), role: 'owner', note: 'you · created this space' },
    { id: 'g-sp-2', resource: { type: 'space', id: 'sp-northgate' }, subject: { type: 'team', id: 't-sales', name: 'Sales team', initials: 'ST' }, role: 'reader', note: '6 people' },
    { id: 'g-sp-3', resource: { type: 'space', id: 'sp-northgate' }, subject: subj(ana), role: 'editor', note: 'added by you' },
  ];

  const accessDefaults: AccessDefault[] = [
    { id: 'only-me', label: 'Only me' },
    { id: 'space-team-read', label: "The space's team · read" },
    { id: 'filed-space-read', label: 'The space I file it in · read' },
    { id: 'ideas-team-read', label: 'Ideas · team can read' },
    { id: 'workspace-read', label: 'Everyone in Deepwork · read' },
  ];

  const connectors: Connector[] = [
    { id: 'claude-code', source: 'claude-code', name: 'Claude Code', detail: "sessions follow the folder's space", connected: true, defaultAccess: 'space-team-read' },
    { id: 'chatgpt', source: 'chatgpt', name: 'ChatGPT', detail: 'remote MCP · signed in', connected: true, defaultAccess: 'only-me' },
    { id: 'claude', source: 'claude', name: 'Claude', detail: 'remote MCP · signed in', connected: true, defaultAccess: 'only-me' },
    { id: 'hermes', source: 'hermes', name: 'Hermes', detail: 'personal agent · access token', connected: true, defaultAccess: 'only-me' },
    { id: 'meetings', source: 'meeting', name: 'Meetings', detail: 'Zoom, Meet, Teams · no bot joins', connected: true, defaultAccess: 'filed-space-read' },
    { id: 'voice', source: 'voice', name: 'Voice and screenshots', detail: 'hold fn · on this Mac', connected: true, defaultAccess: 'ideas-team-read' },
    { id: 'cursor', source: 'cursor', name: 'Cursor', detail: 'not connected', connected: false, defaultAccess: 'only-me' },
  ];

  const skills: Skill[] = [
    {
      id: 'sk-marketing',
      name: 'Sharpen a marketing message',
      description: 'Rewrites a draft in our voice: short sentences, one claim, no superlatives. Pulls the current positioning from the marketing space.',
      meta: 'v4 · used 31 times this month',
      sharedWith: 'marketing · sales',
      version: 4,
    },
    {
      id: 'sk-followup',
      name: 'Follow-up after a customer call',
      description: 'Turns a meeting session into a follow-up email with decisions, owners and dates.',
      meta: 'v2 · used 12 times this month',
      sharedWith: 'sales',
      version: 2,
    },
    {
      id: 'sk-pr',
      name: 'Write a pull request description',
      description: 'What changed, why, how it was tested. Reads the coding session it came from.',
      meta: 'v7 · skill file · claude code, cursor',
      sharedWith: 'engineering',
      version: 7,
    },
    {
      id: 'sk-weekly',
      name: 'Weekly update for founders',
      description: 'Collects decisions and open questions across every space you can read.',
      meta: 'v1 · draft',
      sharedWith: 'only me',
      version: 1,
    },
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

  return { workspace, spaces, sessions, context, pages, grants, accessDefaults, connectors, skills, models };
}
