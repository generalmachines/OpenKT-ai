/**
 * Sample skills for the mock adapter. The first one is the skill drawn on
 * design/canvas/Skill.dc.html (text from design/gen3.py); the rest are written
 * the way a team would really write them, so opening one shows real content.
 */
import { toSkillFile } from '../skillFiles';
import type { Grant, Id, Role, SkillFile } from '../types';

export interface SeedSkillVersion {
  version: number;
  changeNote: string;
  createdBy: { id: Id; name: string };
  createdAt: string;
  files: SkillFile[];
}

export interface SeedSkill {
  id: Id;
  slug: string;
  title: string;
  spaceId: Id;
  spaceName: string;
  owner: { id: Id; name: string };
  runCount30d: number;
  myRole: Role;
  archived?: boolean;
  /** Oldest first. */
  versions: SeedSkillVersion[];
}

const f = (path: string, content: string): SkillFile => toSkillFile({ path, content });

const MARKETING_V4 = `---
name: sharpen-marketing-message
description: Rewrite a marketing draft in our voice. Use when someone shares launch copy, an email, a post or a headline and asks to tighten it.
---

# Sharpen a marketing message

Rewrite the draft so it sounds like us.

## Voice
- Short sentences. One claim per message.
- Plain words. No superlatives, no "revolutionary", no exclamation marks.
- Say who it is for in the first line.

The full voice guide is in [references/voice.md](references/voice.md). Before-and-after pairs are in [references/examples.md](references/examples.md).

## Steps
1. Ask OpenKT for the current positioning: recall "positioning" in the marketing space.
2. Find the single claim the draft is trying to make. If there are two, ask which one.
3. Rewrite. Keep it under 60 words unless asked otherwise.
4. Show the rewrite, then one line on what you changed.

## Output
\`\`\`
<the rewrite>

Changed: <one line>
\`\`\`
`;

const MARKETING_V3 = MARKETING_V4.replace('Keep it under 60 words unless asked otherwise.', 'Keep it under 90 words unless asked otherwise.');
const MARKETING_V2 = MARKETING_V3.replace('1. Ask OpenKT for the current positioning: recall "positioning" in the marketing space.\n2. Find', '1. Find')
  .replace('\n3. Rewrite.', '\n2. Rewrite.')
  .replace('\n4. Show the rewrite', '\n3. Show the rewrite');
const MARKETING_V1 = `---
name: sharpen-marketing-message
description: Rewrite a marketing draft in our voice.
---

# Sharpen a marketing message

Rewrite the draft so it sounds like us: short sentences, one claim, plain words.
`;

const VOICE_MD = `# Our voice

We write the way a good colleague talks across a desk: direct, specific, never selling.

## Always
- Lead with who it is for. "For store managers who…" beats "Introducing…".
- One claim per message. If a second claim matters, it gets its own message.
- Numbers over adjectives. "Cuts reorder time from two days to ten minutes", not "much faster".
- Verbs in the present tense.

## Never
- Superlatives: best, fastest, most powerful, revolutionary, game-changing.
- Exclamation marks, emoji, or a question as a headline.
- "We're excited to announce". Nobody is excited to read that.
- Jargon the customer would not say back to us: synergy, leverage, unlock, seamless.

## Length
| Where | Limit |
| --- | --- |
| Headline | 8 words |
| Post | 60 words |
| Launch email | 120 words, one link |

## When the draft fights back
If the draft has two claims and the author wants both, write two messages and say which should go first.
`;

const EXAMPLES_MD = `# Before and after

Real drafts from the marketing space, with what changed and why.

## Launch post — planogram checks

**Before**
> We're thrilled to unveil our revolutionary AI-powered planogram compliance engine, which seamlessly empowers retailers to unlock unprecedented shelf insights!

**After**
> For store managers: photograph a shelf and see what is out of place in under a minute. No scanner, no training.

Changed: named the reader, swapped five adjectives for one number, cut the exclamation mark.

## Email subject — pricing change

**Before**
> Exciting updates to our pricing structure that you'll love

**After**
> Pricing is now per store, not per seat

Changed: said the actual change. The reader decides whether they love it.

## Headline — case study

**Before**
> How Northgate Transformed Their Operations With Us

**After**
> Northgate reorders in ten minutes, not two days

Changed: the customer's result is the headline; we are not in it.
`;

const FOLLOWUP_MD = `---
name: follow-up-after-a-customer-call
description: Turn a customer meeting into a follow-up email with decisions, owners and dates. Use right after a call, or when someone asks "can you draft the follow-up".
---

# Follow-up after a customer call

Write the email the customer should get within an hour of the call ending.

## Before you write
1. Open the meeting session in OpenKT and read its saved context: decisions, actions and open questions.
2. Recall the customer's name in the sales space to check what was promised on earlier calls. Do not repeat a promise that has already been kept.
3. If no action has an owner or a date, stop and ask who owns what. An email with loose ends is worse than a late one.

## The email
- Subject: the customer's name and the one thing that was decided.
- First line: thank them in one short sentence, then straight to the decisions.
- **Decided** — a list, one line each, in their words where you can.
- **Next steps** — who, what, by when. Ours first, then theirs.
- **Still open** — questions nobody could answer on the call, and who is finding out.
- Close with the date of the next conversation if there is one.

Use the layout in [references/email-template.md](references/email-template.md).

## Rules
- Under 150 words. Nobody reads a long follow-up.
- Never invent a date. If the call did not set one, write "date to confirm" and flag it.
- Quote prices and numbers exactly as they were said.
`;

const FOLLOWUP_V1 = FOLLOWUP_MD.replace('- Under 150 words. Nobody reads a long follow-up.\n', '');

const EMAIL_TEMPLATE_MD = `# Follow-up email layout

\`\`\`
Subject: <Customer> — <the decision in five words>

Hi <first name>,

Thanks for the time today. Here is where we landed.

Decided
- <decision, in their words>
- <decision>

Next steps
- <our owner>: <action> by <date>
- <their owner>: <action> by <date>

Still open
- <question> — <who is finding out>

We speak again on <date>.

<your name>
\`\`\`

Leave out any section that would be empty. Never send "Still open: none".
`;

const PR_MD = `---
name: write-a-pull-request-description
description: Write the description for a pull request from the coding session it came from. Use when a branch is ready for review and needs its "what, why, how tested".
---

# Write a pull request description

A reviewer should understand the change without opening the diff, and trust it after reading how it was tested.

## Gather
1. Read the coding session this branch came from: the decisions made along the way are the "why".
2. Run \`git diff main...HEAD --stat\` for the shape of the change, then read the diff itself.
3. Find the commands that were run to test it. If none were, say so plainly — do not imply tests that did not happen.

## Write
Use exactly these sections:

\`\`\`md
## What changed
<two or three sentences, in the product's words>

## Why
<the decision behind it, with a link to the session or issue>

## How it was tested
<commands run and what they showed; manual checks; what was NOT tested>

## Anything unsure
<or "nothing">
\`\`\`

## Rules
- The title is an imperative sentence under 70 characters: "Quote per store on the pricing page".
- No file-by-file tour. The diff already has that.
- Link the issue with \`Closes #<n>\` on the first line when there is one.
- If the change touches a migration, call it out in **What changed** in bold.
`;

const WEEKLY_MD = `---
name: weekly-update-for-founders
description: Collect the week's decisions and open questions across every space into a one-page update. Use on Friday afternoon, or when asked "what happened this week".
---

# Weekly update for founders

One page. What was decided, what is stuck, what needs a founder.

## Steps
1. Recall decisions from the last seven days in every space you can read.
2. Recall open questions older than three days. Those are the stuck ones.
3. Group by space. Skip a space where nothing happened.
4. End with **Needs you**: at most three items that only a founder can unblock.

## Format
- Each decision is one line, with the person who made it.
- No adjectives about how the week went.
- Under 300 words.
`;

const TRIAGE_MD = `---
name: triage-a-bug-report
description: Turn a raw bug report into a triaged issue with severity, a reproduction and a likely owner. Use when a report arrives by chat, email or a support ticket.
---

# Triage a bug report

Get from "it's broken" to an issue someone can pick up without asking a single question.

## Steps
1. Restate the problem in one sentence: what the person did, what they expected, what happened instead.
2. Recall the affected area in the engineering space. If there is a known issue or a recent decision about it, link it and stop — do not file a duplicate.
3. Write the smallest reproduction you can. If you cannot reproduce it from the report, list exactly what is missing.
4. Set the severity from [references/severity.md](references/severity.md).
5. Name a likely owner: whoever last changed that area, from the coding sessions.

## Output
- **Title** — the symptom, not the guess at the cause.
- **Severity** — S1 to S4, with the one-line reason.
- **Reproduce** — numbered steps.
- **Expected / actual**
- **Likely owner**
- **Missing** — what you still need from the reporter, if anything.
`;

const SEVERITY_MD = `# Severity

| Level | Means | Respond within |
| --- | --- | --- |
| S1 | Data loss, a security hole, or nobody can sign in | 1 hour |
| S2 | A main flow is broken for many people, no workaround | same day |
| S3 | Broken, but there is a workaround | this week |
| S4 | Cosmetic, or a rare edge case | when convenient |

When in doubt between two levels, pick the more severe one and say why.
`;

export function createSeedSkills(at: (daysAgo: number, hh: number, mm: number) => string): { skills: SeedSkill[]; grants: Grant[] } {
  const me = { id: 'u-pratham', name: 'Pratham Bhatnagar' };
  const ana = { id: 'u-ana', name: 'Ana Reyes' };
  const ravi = { id: 'u-ravi', name: 'Ravi Menon' };
  const refs = [f('references/voice.md', VOICE_MD), f('references/examples.md', EXAMPLES_MD)];

  const prVersions: SeedSkillVersion[] = [
    [1, '', 40],
    [2, 'added the “Anything unsure” section', 33],
    [3, '', 27],
    [4, 'titles are imperative now', 20],
    [5, 'say what was not tested', 12],
    [6, '', 8],
    [7, 'call out migrations in bold', 1],
  ].map(([version, changeNote, days]) => ({
    version: version as number,
    changeNote: changeNote as string,
    createdBy: (version as number) % 3 === 0 ? ravi : me,
    createdAt: at(days as number, 15, 10),
    files: [f('SKILL.md', (version as number) < 7 ? PR_MD.replace('- If the change touches a migration, call it out in **What changed** in bold.\n', '') : PR_MD)],
  }));

  const skills: SeedSkill[] = [
    {
      id: 'sk-marketing',
      slug: 'sharpen-marketing-message',
      title: 'Sharpen a marketing message',
      spaceId: 'sp-marketing',
      spaceName: 'marketing',
      owner: ana,
      runCount30d: 31,
      myRole: 'editor',
      versions: [
        { version: 1, changeNote: '', createdBy: ana, createdAt: at(44, 11, 0), files: [f('SKILL.md', MARKETING_V1)] },
        { version: 2, changeNote: '', createdBy: ana, createdAt: at(35, 14, 20), files: [f('SKILL.md', MARKETING_V2), ...refs] },
        { version: 3, changeNote: 'added the recall step', createdBy: ravi, createdAt: at(21, 9, 45), files: [f('SKILL.md', MARKETING_V3), ...refs] },
        { version: 4, changeNote: 'shorter word limit', createdBy: ana, createdAt: at(2, 16, 5), files: [f('SKILL.md', MARKETING_V4), ...refs] },
      ],
    },
    {
      id: 'sk-followup',
      slug: 'follow-up-after-a-customer-call',
      title: 'Follow-up after a customer call',
      spaceId: 'sp-sales',
      spaceName: 'sales',
      owner: ana,
      runCount30d: 12,
      myRole: 'reader',
      versions: [
        { version: 1, changeNote: '', createdBy: ana, createdAt: at(30, 10, 0), files: [f('SKILL.md', FOLLOWUP_V1), f('references/email-template.md', EMAIL_TEMPLATE_MD)] },
        { version: 2, changeNote: 'keep it under 150 words', createdBy: ana, createdAt: at(9, 13, 30), files: [f('SKILL.md', FOLLOWUP_MD), f('references/email-template.md', EMAIL_TEMPLATE_MD)] },
      ],
    },
    {
      id: 'sk-pr',
      slug: 'write-a-pull-request-description',
      title: 'Write a pull request description',
      spaceId: 'sp-openkt',
      spaceName: 'openkt',
      owner: me,
      runCount30d: 18,
      myRole: 'owner',
      versions: prVersions,
    },
    {
      id: 'sk-triage',
      slug: 'triage-a-bug-report',
      title: 'Triage a bug report',
      spaceId: 'sp-openkt',
      spaceName: 'openkt',
      owner: ravi,
      runCount30d: 7,
      myRole: 'editor',
      versions: [
        { version: 1, changeNote: '', createdBy: ravi, createdAt: at(25, 12, 0), files: [f('SKILL.md', TRIAGE_MD.replace('2. Recall', '2. Search').replace(' — do not file a duplicate', ''))] },
        { version: 2, changeNote: 'severity table moved to its own file', createdBy: ravi, createdAt: at(14, 12, 0), files: [f('SKILL.md', TRIAGE_MD.replace(' — do not file a duplicate', '')), f('references/severity.md', SEVERITY_MD)] },
        { version: 3, changeNote: 'check for duplicates first', createdBy: me, createdAt: at(5, 17, 40), files: [f('SKILL.md', TRIAGE_MD), f('references/severity.md', SEVERITY_MD)] },
      ],
    },
    {
      id: 'sk-weekly',
      slug: 'weekly-update-for-founders',
      title: 'Weekly update for founders',
      spaceId: 'sp-personal',
      spaceName: 'personal',
      owner: me,
      runCount30d: 0,
      myRole: 'owner',
      versions: [{ version: 1, changeNote: '', createdBy: me, createdAt: at(3, 18, 0), files: [f('SKILL.md', WEEKLY_MD)] }],
    },
  ];

  const user = (p: { id: Id; name: string }, initials: string) => ({ type: 'user' as const, id: p.id, name: p.name, initials, email: `${p.name.split(' ')[0]!.toLowerCase()}@example.com` });
  const team = (id: Id, name: string, initials: string) => ({ type: 'team' as const, id, name, initials });
  const on = (id: Id) => ({ type: 'skill' as const, id });
  const grants: Grant[] = [
    // Skill.dc.html "Who can use it"
    { id: 'g-sk-1', resource: on('sk-marketing'), subject: user(ana, 'AN'), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-2', resource: on('sk-marketing'), subject: team('t-marketing', 'Marketing', 'MK'), role: 'editor', note: '7 people' },
    { id: 'g-sk-3', resource: on('sk-marketing'), subject: team('t-sales', 'Sales', 'SA'), role: 'reader', note: '7 people' },

    { id: 'g-sk-4', resource: on('sk-followup'), subject: user(ana, 'AN'), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-5', resource: on('sk-followup'), subject: team('t-sales', 'Sales', 'SA'), role: 'reader', note: '7 people' },

    { id: 'g-sk-6', resource: on('sk-pr'), subject: user(me, 'PB'), role: 'owner', note: 'you · wrote this skill', inherited: true },
    { id: 'g-sk-7', resource: on('sk-pr'), subject: team('t-openkt', 'OpenKT', 'OK'), role: 'editor', note: '3 people' },
    { id: 'g-sk-8', resource: on('sk-pr'), subject: user(ana, 'AN'), role: 'reader', note: 'added by you' },

    { id: 'g-sk-9', resource: on('sk-triage'), subject: user(ravi, 'RM'), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-10', resource: on('sk-triage'), subject: team('t-openkt', 'OpenKT', 'OK'), role: 'editor', note: '3 people' },

    { id: 'g-sk-11', resource: on('sk-weekly'), subject: user(me, 'PB'), role: 'owner', note: 'you · wrote this skill', inherited: true },
  ];
  return { skills, grants };
}
