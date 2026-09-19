/**
 * Skills each team would write from what its pages know. The steps restate the
 * teams' own facts (the discovery questions, the sepsis bundle, the cap); one of
 * them changed when the team's position changed, so its history shows it.
 */
import { initialsOf } from '../../format';
import { toSkillFile } from '../../skillFiles';
import type { Grant, Id, SkillFile } from '../../types';
import type { SeedSkill } from '../skills';

const f = (path: string, content: string): SkillFile => toSkillFile({ path, content });

const DISCOVERY_V1 = `---
name: run-a-sales-discovery-call
description: Prepare for and run a first discovery call the way our sales team does. Use before a first call with a new prospect, or to check call notes against our qualification rules.
---

# Run a sales discovery call

Qualify with MEDDICC. The call is not done until you know who the Economic Buyer and the Champion are.

## Before the call
1. Ask OpenKT: recall "ICP" and "Acmeflow" in the sales space.
2. Check the prospect against the ICP: mid-market fintech, 200-2000 employees, with a named security owner.
3. Prepare one slide that frames their problem. Not the 12-slide corporate deck.

## On the call
- Find the Economic Buyer and the Champion. An opp can't move to Stage 3 without both.
- Against Acmeflow: demo native SSO and audit logs in the first 10 minutes, and quantify implementation time (under 30 days against their 90).
- Price or security as the lead is still open between Marcus and Tomas. Read both positions on the Sales Presentation & Deal Framing Strategy page before you choose.

## After the call
- Write the next step and the close date into Salesforce: no fields, no forecast credit.
- If a trial follows, book the kickoff and write 2-3 success criteria into the deal notes.
`;

const DISCOVERY = DISCOVERY_V1.replace(
  '## On the call\n',
  '## On the call\n- Ask "what happens if you do nothing?" to surface the cost of inaction.\n',
);

const SEPSIS_V1 = `---
name: start-the-sepsis-bundle
description: Walk through our 1-hour sepsis bundle from the triage screen to the first antibiotic. Use when a patient screens positive on qSOFA or sepsis is suspected on the floor.
---

# Start the sepsis bundle

## Screen
- qSOFA at triage: RR ≥ 22, altered mentation, SBP ≤ 100.
- Any 2 of the 3 pages the rapid-response team immediately.

## The first hour
1. Draw lactate.
2. Draw blood cultures before the first antibiotic dose.
3. Give broad-spectrum antibiotics. Door-to-antibiotic target is under 60 minutes for suspected septic shock.
4. 30 mL/kg crystalloid for hypotension or lactate ≥ 4.
`;

const SEPSIS = `${SEPSIS_V1}
## After the first hour
- Repeat lactate at 2-4 hours if the first was elevated. The trend guides fluids more than a single value.
- Document the indication and planned stop date on every antibiotic order.
- De-escalate at 48-72 hours once cultures and sensitivities return.
`;

const CAP_V1 = `---
name: negotiate-the-liability-cap
description: Mark up the limitation-of-liability clause in a customer MSA to our standard. Use when a customer redlines the cap, the indemnity or the damages exclusions.
---

# Negotiate the liability cap

## Our standard
- The cap is a flat $1,000,000 aggregate; the data-breach carve-out sits above the cap.

## When the customer pushes
1. Offer mutual limitation of liability: we trade symmetry for keeping the cap number where we want it.
2. Never agree to uncapped indirect or consequential damages. That is a walk-away term: escalate to Helena.
3. Governing law stays Delaware unless the deal is strategic.
`;

const CAP = `${CAP_V1.replace(
  '- The cap is a flat $1,000,000 aggregate; the data-breach carve-out sits above the cap.\n',
  '- The cap is 12 months of fees paid. Legacy contracts keep the $1M cap until they renew.\n- The indemnity cap is carved out from the general cap and runs to the same 12-months-fees number unless negotiated higher.\n- The DPA’s liability is tied back to the MSA cap, so the change reaches data-protection exposure too.\n',
)}
## Before you sign
- File the executed agreement in the CLM with counterparty, value, renewal date, auto-renewal flag and assigned attorney.
- Anything over $500k TCV goes to the board approval queue.
`;

const CAMPAIGN = `---
name: launch-a-campaign
description: Check a campaign is ready to ship, with its tracking plan, test design and the scoreboard it will be judged on. Use before any paid, email or content campaign goes live.
---

# Launch a campaign

## Tracking plan
- UTMs on every link.
- One named primary KPI.
- A minimum detectable effect, defined before launch.

## Testing
- Hold tests to 95% significance and a pre-registered sample size. No peeking, no stopping early.
- Scale only after 50+ conversions; below that, CPA swings are noise.

## The scoreboard
- Pipeline and CAC payback. Not CTR.
- Blended CAC target is $400; a channel above a 3-month payback is paused and reworked.
- Paid leads go into the 5-email nurture before sales touches them.
`;

const RECOVERY = `---
name: recover-a-table
description: Handle a guest complaint on the floor the way our front of house does. Use when a table is unhappy, a plate goes back, or a comp is on the table.
---

# Recover a table

## LAST
1. Listen.
2. Apologize.
3. Solve.
4. Thank.

## Comps and remakes
- A manager touches every comped or remade plate before it leaves the kitchen.
- Log the comp with a reason code. A spike in “long ticket time” comps points to kitchen staffing, not the server.

## Allergies
- An allergy plate is a fresh-glove, clean-board, dedicated-pan cook, and the expo double-checks it before it leaves the pass.
`;

const STAGE = `---
name: add-a-pipeline-stage
description: Add or change a stage in the OpenKT memory pipeline without breaking recall. Use when touching preprocess, embed, triage, classify_kb or mm-sync.
---

# Add a pipeline stage

## The chain
preprocess → embed (Titan) → triage → classify_kb, with mm-sync in parallel on a 5-minute cron.

## Rules
- Track the stage in agentic_jobs with an idempotency key, retries and a dead-letter path.
- Embed through the one canonical Titan module. BGE is gone.
- Recall stays MemMachine. Do not add a second recall path.
- Don’t run terraform without -target when the state has unapplied drift.

## Before you merge
1. Run the end-to-end shakeout on the local docker-compose stack: outbox → preprocess → embed → triage → episode → briefing → recall.
2. Check the fallback: with MemMachine unhealthy, recall still reads features from Postgres.
`;

export function createShowcaseSkills(at: (daysAgo: number, hh: number, mm: number) => string, me: { id: Id; name: string }): { skills: SeedSkill[]; grants: Grant[] } {
  const person = (id: Id, name: string) => ({ id, name });
  const dana = person('u-dana', 'Dana');
  const marcus = person('u-marcus', 'Marcus');
  const rosa = person('u-rosa-rn', 'Rosa');
  const ekwueme = person('u-ekwueme', 'Dr. Ekwueme');
  const derek = person('u-derek', 'Derek');
  const helena = person('u-helena', 'Helena');
  const pavel = person('u-pavel', 'Pavel');
  const amira = person('u-amira', 'Amira');

  const skills: SeedSkill[] = [
    {
      id: 'sk-discovery',
      slug: 'run-a-sales-discovery-call',
      title: 'Run a sales discovery call',
      spaceId: 'sp-sales',
      spaceName: 'sales',
      owner: dana,
      runCount30d: 23,
      myRole: 'editor',
      versions: [
        { version: 1, changeNote: '', createdBy: dana, createdAt: at(20, 9, 30), files: [f('SKILL.md', DISCOVERY_V1)] },
        { version: 2, changeNote: 'added the do-nothing question', createdBy: marcus, createdAt: at(6, 17, 10), files: [f('SKILL.md', DISCOVERY)] },
      ],
    },
    {
      id: 'sk-sepsis',
      slug: 'start-the-sepsis-bundle',
      title: 'Start the sepsis bundle',
      spaceId: 'sp-healthcare',
      spaceName: 'healthcare',
      owner: rosa,
      runCount30d: 14,
      myRole: 'reader',
      versions: [
        { version: 1, changeNote: '', createdBy: rosa, createdAt: at(26, 7, 45), files: [f('SKILL.md', SEPSIS_V1)] },
        { version: 2, changeNote: 'repeat lactate, stop dates, de-escalation', createdBy: ekwueme, createdAt: at(1, 8, 20), files: [f('SKILL.md', SEPSIS)] },
      ],
    },
    {
      id: 'sk-liability',
      slug: 'negotiate-the-liability-cap',
      title: 'Negotiate the liability cap',
      spaceId: 'sp-legal',
      spaceName: 'legal',
      owner: derek,
      runCount30d: 9,
      myRole: 'editor',
      versions: [
        { version: 1, changeNote: '', createdBy: derek, createdAt: at(39, 11, 0), files: [f('SKILL.md', CAP_V1)] },
        { version: 2, changeNote: 'the cap is 12 months of fees now', createdBy: helena, createdAt: at(8, 11, 5), files: [f('SKILL.md', CAP)] },
      ],
    },
    {
      id: 'sk-campaign',
      slug: 'launch-a-campaign',
      title: 'Launch a campaign',
      spaceId: 'sp-marketing',
      spaceName: 'marketing',
      owner: pavel,
      runCount30d: 17,
      myRole: 'editor',
      versions: [{ version: 1, changeNote: '', createdBy: pavel, createdAt: at(4, 17, 30), files: [f('SKILL.md', CAMPAIGN)] }],
    },
    {
      id: 'sk-recovery',
      slug: 'recover-a-table',
      title: 'Recover a table',
      spaceId: 'sp-hospitality',
      spaceName: 'hospitality',
      owner: amira,
      runCount30d: 11,
      myRole: 'editor',
      versions: [{ version: 1, changeNote: '', createdBy: amira, createdAt: at(4, 12, 30), files: [f('SKILL.md', RECOVERY)] }],
    },
    {
      id: 'sk-stage',
      slug: 'add-a-pipeline-stage',
      title: 'Add a pipeline stage',
      spaceId: 'sp-openkt',
      spaceName: 'openkt',
      owner: me,
      runCount30d: 6,
      myRole: 'owner',
      versions: [{ version: 1, changeNote: '', createdBy: me, createdAt: at(4, 11, 15), files: [f('SKILL.md', STAGE)] }],
    },
  ];

  const user = (p: { id: Id; name: string }) => ({ type: 'user' as const, id: p.id, name: p.name, initials: initialsOf(p.name) });
  const team = (id: Id, name: string) => ({ type: 'team' as const, id, name, initials: initialsOf(name) });
  const on = (id: Id) => ({ type: 'skill' as const, id });
  const grants: Grant[] = [
    { id: 'g-sk-discovery-1', resource: on('sk-discovery'), subject: user(dana), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-discovery-2', resource: on('sk-discovery'), subject: team('t-sales', 'Sales'), role: 'editor', note: '7 people' },
    { id: 'g-sk-sepsis-1', resource: on('sk-sepsis'), subject: user(rosa), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-sepsis-2', resource: on('sk-sepsis'), subject: team('t-healthcare', 'Healthcare'), role: 'reader', note: '7 people' },
    { id: 'g-sk-liability-1', resource: on('sk-liability'), subject: user(derek), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-liability-2', resource: on('sk-liability'), subject: team('t-legal', 'Legal'), role: 'editor', note: '7 people' },
    { id: 'g-sk-campaign-1', resource: on('sk-campaign'), subject: user(pavel), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-campaign-2', resource: on('sk-campaign'), subject: team('t-marketing', 'Marketing'), role: 'editor', note: '7 people' },
    { id: 'g-sk-recovery-1', resource: on('sk-recovery'), subject: user(amira), role: 'owner', note: 'wrote this skill', inherited: true },
    { id: 'g-sk-recovery-2', resource: on('sk-recovery'), subject: team('t-hospitality', 'Hospitality'), role: 'editor', note: '7 people' },
    { id: 'g-sk-stage-1', resource: on('sk-stage'), subject: user(me), role: 'owner', note: 'you · wrote this skill', inherited: true },
    { id: 'g-sk-stage-2', resource: on('sk-stage'), subject: team('t-openkt', 'OpenKT'), role: 'editor', note: '3 people' },
  ];
  return { skills, grants };
}
