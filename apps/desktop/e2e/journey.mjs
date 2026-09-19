#!/usr/bin/env node
/**
 * The journey a new person takes through OpenKT, driven through the real app against the
 * real server (OPENKT_E2E_SERVER, default https://api.openkt.ai). Every screen is
 * screenshotted and every visible piece of data is classified:
 *
 *   REAL          it came from the server (checked against main's request log or a direct API call)
 *   MOCK          hard-coded or sample content shown to a signed-in person
 *   EMPTY-HONEST  nothing to show, and the screen says so
 *   BROKEN        the step cannot be completed
 *
 * Output: e2e/artifacts/*.png, summary.json, console-*.json, requests-*.json, main-*.log.
 * Exit code: 1 when any finding is a BLOCKER, else 0.
 *
 * Run: `npm run e2e -w @openkt/desktop` (Linux wraps itself in xvfb-run; see run.mjs).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppInstance, ARTIFACTS, MOCK_MARKERS, PACKAGED, Recorder, SERVER, api, rand, resetArtifacts, sleep } from './harness.mjs';

const PASSWORD = 'correct horse battery 42';
const run = rand();
/**
 * OPENKT_E2E_ACCOUNTS=<id>: sign in as the existing pair e2e-<id>-a / e2e-<id>-b (same password) instead of
 * creating two accounts. Use it whenever sign-ups are rate-limited, and in CI (repository variable of the same name).
 */
const REUSE = (process.env.OPENKT_E2E_ACCOUNTS || '').trim();
/**
 * OPENKT_E2E_TOKENS=<tokenA>,<tokenB>: start both copies of the app already signed in with these access tokens
 * (no sign-up, no sign-in, no sign-out: nothing touches /v1/auth). For when the server rate-limits sign-ins.
 */
const SEEDED = (process.env.OPENKT_E2E_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
const EXISTING = Boolean(REUSE || SEEDED.length === 2);
const acct = REUSE || run;
const A = { name: `E2E Owner ${acct}`, email: `e2e-${acct}-a@e2e.openkt.test` };
const B = { name: `E2E Teammate ${acct}`, email: `e2e-${acct}-b@e2e.openkt.test` };
const NOTE = {
  title: `Walrus pricing ${run}`,
  body: `Decision ${run}: we quote the Walrus Grocers account per store, not per seat. Walrus runs 23 stores; 4 are still on the legacy till. Mira sends the revised quote by Friday.`,
  query: `how do we price Walrus ${run}`,
};
const SPACE = { name: `E2E Team ${run}` };
const TEAM_NOTE = {
  title: `Heron renewal ${run}`,
  body: `Heron Freight ${run} renews in March. They want single sign-on before they sign; Priya owns the SSO answer.`,
  query: `when does Heron Freight renew ${run}`,
};

const rec = new Recorder();
const created = { emails: [], sessionIds: [], memoryIds: [] };
let tokenA = '';
let tokenB = '';
let sessionId = '';

/** Sample data on a signed-in screen. `labelled`: the screen carries the "Preview — sample data" badge. */
async function classifyMock(app, screen, shot, { owner = 'qa', severity = 'blocker', labelledSeverity = 'major', selector = 'body' } = {}) {
  const hits = await app.mockHits(selector);
  if (hits.length === 0) return hits;
  const labelled = /Preview — sample data|sample data/i.test(await app.text('.preview').catch(() => ''));
  rec.finding({
    screen,
    item: `sample content shown to a signed-in person: ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ` … (+${hits.length - 6})` : ''}`,
    cls: 'MOCK',
    severity: labelled ? labelledSeverity : severity,
    owner,
    evidence: shot,
    note: labelled ? 'carries a "Preview — sample data" badge' : 'NOT labelled as sample data',
  });
  return hits;
}

/** A result row (not the "Nothing relevant for …" line) mentioning `needle`; `group`: only under that heading (Context, Sessions). */
async function paletteHas(app, needle, group = '') {
  const rows = await app.page.locator(`#palette-results ${group ? `[role="group"][aria-label="${group}"] ` : ''}[role="option"]`).allInnerTexts().catch(() => []);
  return rows.some((r) => r.includes(needle));
}

const a = new AppInstance('A');
let b = null;

try {
  resetArtifacts();
  console.log(`OpenKT journey · server ${SERVER} · ${PACKAGED ? `packaged app ${PACKAGED}` : 'dev build'} · run ${run}${SEEDED.length === 2 ? ' · pre-issued tokens' : REUSE ? ` · signing in as e2e-${REUSE}-a/-b` : ' · creating two accounts'}`);

  // ── 1. first launch ────────────────────────────────────────────────────────────────────────────
  await rec.step('First launch', async (row) => {
    await a.launch();
    await a.settle();
    row.shot = await a.shot('first-launch');
    const route = a.route();
    const text = await a.text();
    if (route !== '/welcome') throw new Error(`a first launch should open the sign-in screen, got ${route}`);
    rec.finding({ screen: 'Welcome', item: 'first launch opens the sign-in card', cls: 'REAL', evidence: row.shot, note: `GET /v1/auth/providers → ${(await a.requests()).find((r) => r.path.includes('/auth/providers'))?.status ?? 'not requested'}` });
    const hits = MOCK_MARKERS.filter((m) => text.includes(m));
    if (hits.length) rec.finding({ screen: 'Welcome', item: `sample content before sign-in: ${hits.join(', ')}`, cls: 'MOCK', severity: 'major', evidence: row.shot });
  });

  // ── 2. create an account through the UI (or sign in to the reused one) ────────────────────────
  if (SEEDED.length === 2)
    await rec.step('Start signed in with a pre-issued token (sign-ins are rate-limited)', async (row) => {
      tokenA = SEEDED[0];
      const me = await api(tokenA, 'GET', '/v1/me');
      if (me.status !== 200) throw new Error(`the token in OPENKT_E2E_TOKENS is not accepted: /v1/me → ${me.status}`);
      Object.assign(A, { email: me.data.email, name: me.data.display_name || me.data.email });
      await a.seedToken(tokenA, A.email);
      row.shot = await a.shot('seeded');
      if (a.route().includes('/welcome')) throw new Error('the app did not pick up the stored token');
      rec.finding({ screen: 'Welcome', item: 'not exercised: signing up and signing in (the server was refusing sign-ins from this IP with 429); started with a stored token', cls: 'EMPTY-HONEST', evidence: row.shot, note: `as ${A.email}` });
    });
  else if (REUSE)
    await rec.step('Sign in through the UI (reused account)', async (row) => {
      const p = a.page;
      const t0 = Date.now();
      await p.locator('input[name="email"]').fill(A.email);
      await p.locator('input[name="password"]').fill(PASSWORD);
      row.shot = await a.shot('signin-filled');
      await p.getByRole('button', { name: 'Sign in', exact: true }).click();
      await p.waitForFunction(() => !location.hash.includes('/welcome'), null, { timeout: 30_000 }).catch(() => undefined);
      await a.settle();
      row.shot = await a.shot('after-signin');
      const login = (await a.requests(t0)).find((r) => r.path === '/v1/auth/login');
      if (a.route().includes('/welcome')) throw new Error(`still on the sign-in screen: ${(await a.text('[role="alert"]')) || 'no error shown'} (login → ${login?.status ?? 'no request'})`);
      tokenA = await a.token();
      const me = await api(tokenA, 'GET', '/v1/me');
      if (me.status !== 200 || me.data?.email !== A.email) throw new Error(`the stored token does not belong to ${A.email}: /v1/me → ${me.status}`);
      A.name = me.data.display_name || A.name;
      rec.finding({ screen: 'Welcome', item: 'signed in through the UI; token stored in userData/secrets and accepted by the server', cls: 'REAL', evidence: row.shot, note: `account reused (OPENKT_E2E_ACCOUNTS); POST /v1/auth/login → ${login?.status}` });
    });
  else await rec.step('Create an account through the UI', async (row) => {
    const p = a.page;
    const t0 = Date.now();
    await p.getByRole('button', { name: 'Create an account' }).click();
    await p.locator('input[name="name"]').fill(A.name);
    await p.locator('input[name="email"]').fill(A.email);
    await p.locator('input[name="password"]').fill(PASSWORD);
    row.shot = await a.shot('signup-filled');
    await p.getByRole('button', { name: 'Create account' }).click();
    await p.waitForFunction(() => !location.hash.includes('/welcome'), null, { timeout: 30_000 }).catch(() => undefined);
    await a.settle();
    row.shot = await a.shot('after-signup');
    created.emails.push(A.email);
    const signup = (await a.requests(t0)).find((r) => r.path === '/v1/auth/signup');
    if (a.route().includes('/welcome')) throw new Error(`still on the sign-in screen: ${(await a.text('[role="alert"]')) || 'no error shown'} (signup → ${signup?.status ?? 'no request'})`);
    tokenA = await a.token();
    const me = await api(tokenA, 'GET', '/v1/me');
    if (me.status !== 200 || me.data?.email !== A.email) throw new Error(`the stored token does not belong to ${A.email}: /v1/me → ${me.status}`);
    rec.finding({ screen: 'Welcome', item: 'account created; token stored in userData/secrets and accepted by the server', cls: 'REAL', evidence: row.shot, note: `POST /v1/auth/signup → ${signup?.status}; GET /v1/me → ${me.data.email}` });
  });

  // ── 3. onboarding ──────────────────────────────────────────────────────────────────────────────
  await rec.step('Onboarding — every step', async (row) => {
    row.owner = 'onboarding';
    const p = a.page;
    if (!a.route().startsWith('/onboarding')) {
      if (!EXISTING) rec.finding({ screen: 'Onboarding', item: `a new account landed on ${a.route()} instead of onboarding`, cls: 'BROKEN', severity: 'minor', owner: 'onboarding' });
      await a.goto('/onboarding/2'); // an existing account on a new Mac: walk the same screens
    }
    // "Set up on-device AI" starts a ~4 GB download the moment it opens. The harness never downloads models:
    // pause first (the step then says "paused", which is what it would say to a person who paused it).
    const paused = await p.evaluate(async () => Boolean(await window.openkt?.models?.pause?.().catch(() => null)));
    const walked = [];
    for (let i = 0; i < 8 && a.route().startsWith('/onboarding'); i++) {
      await a.settle(400);
      const n = Number(a.route().split('/')[2] || 0);
      const shot = await a.shot(`onboarding-${n || 'start'}`);
      const text = await a.text();
      const title = ((await a.text('.onb__h2')) || `step ${n}`).split('\n')[0];
      if (i === 0 && text.includes(A.name)) rec.finding({ screen: 'Onboarding', item: `"Signed in as ${A.name}"`, cls: 'REAL', owner: 'onboarding', evidence: shot });
      const t0 = Date.now();
      if (n === 3) {
        if (/found · ~\/\.claude|found · ~\/\.cursor/.test(text))
          rec.finding({ screen: 'Onboarding · Connect your tools', item: '"found · ~/.claude", "found · ~/.cursor" are hard-coded strings — nothing on this machine was looked at', cls: 'MOCK', severity: 'blocker', owner: 'integrations', evidence: shot, note: 'src/screens/Onboarding.tsx TOOLS (the step-3 slot)' });
        const connect = p.getByRole('button', { name: /^Connect \d+ tools?$/ });
        if (await connect.count()) {
          await connect.click();
          await a.settle(300);
          // Background list refreshes do not count: connecting a tool writes something, or talks to a connector/OAuth endpoint.
          const sent = (await a.requests(t0)).filter((r) => r.method !== 'GET' || /connector|oauth|token|mcp|integration/i.test(r.path));
          rec.finding({ screen: 'Onboarding · Connect your tools', item: `"Connect N tools" ${sent.length ? `made ${sent.length} request(s)` : 'does nothing: no request, no file written — it only moves to the next step'}`, cls: sent.length ? 'REAL' : 'MOCK', severity: sent.length ? 'ok' : 'blocker', owner: 'integrations', evidence: shot, note: 'src/screens/Onboarding.tsx ConnectTools → onDone' });
          walked.push(`${n} ${title} → "${(await connect.textContent().catch(() => '')) || 'Connect'}"`);
          continue;
        }
      }
      if (n === 4) rec.finding({ screen: 'Onboarding · Set up on-device AI', item: `not exercised: the step downloads ~4 GB on entry${paused ? ' (paused by the harness)' : ' — and the harness could NOT pause it'}`, cls: 'EMPTY-HONEST', severity: paused ? 'ok' : 'major', owner: 'onboarding', evidence: shot });
      const primary = p.locator('.onb .btn--accent').last();
      const later = p.getByRole('button', { name: /Do this later/ });
      let pressed = '';
      if ((await primary.count()) && (await primary.isEnabled())) {
        pressed = (await primary.innerText()).trim();
        await primary.click();
      } else if (await later.count()) {
        pressed = 'Do this later';
        await later.click();
      } else break;
      walked.push(`${n} ${title} → "${pressed}"`);
    }
    await a.settle();
    row.shot = await a.shot('landed');
    const done = !a.route().startsWith('/onboarding');
    rec.finding({ screen: 'Onboarding', item: done ? `walked to the end: ${walked.join(' · ')}` : `stuck on ${a.route()} after ${walked.join(' · ')}`, cls: done ? 'REAL' : 'BROKEN', severity: done ? 'ok' : 'blocker', owner: 'onboarding', evidence: row.shot, note: process.platform === 'darwin' ? '' : 'Allow access has nothing to ask for off macOS' });
  });

  // ── 4. landing: is anything fake? ──────────────────────────────────────────────────────────────
  await rec.step('Landing — what a brand-new account sees', async (row) => {
    if (a.route().startsWith('/onboarding')) await a.goto('/');
    await a.settle();
    row.shot = await a.shot('landing');
    const side = await a.text('nav.sidebar');
    const hits = await classifyMock(a, 'Sidebar', row.shot, { selector: 'nav.sidebar' });
    const reqs = await a.requests();
    const listed = reqs.filter((r) => r.path.startsWith('/v1/sessions?'));
    if (!hits.length) {
      const hasRows = (await a.page.locator('nav.sidebar .srow').count()) > 0;
      const honest = /No sessions yet/i.test(side);
      rec.finding({
        screen: 'Sidebar',
        item: hasRows ? 'session list' : honest ? 'empty session list says "No sessions yet"' : 'empty session list is a blank gap — no "No sessions yet", nothing tells a new person the app is working',
        cls: hasRows ? 'REAL' : honest ? 'EMPTY-HONEST' : 'BROKEN',
        severity: hasRows || honest ? 'ok' : 'major',
        evidence: row.shot,
        note: `GET /v1/sessions ×${listed.length} → ${[...new Set(listed.map((r) => r.status))].join(',')}; src/components/Sidebar.tsx`,
      });
    }
    const pill = side.split('\n').slice(0, 4).join(' ');
    const host = new URL(SERVER).host;
    if (pill.includes(host)) rec.finding({ screen: 'Sidebar', item: `the status pill names the server: "${host}"`, cls: 'REAL', evidence: row.shot });
    else rec.finding({ screen: 'Sidebar', item: `the status pill next to "OpenKT" reads "${pill.replace(/^OpenKT\s*/, '').slice(0, 20)}", not the server this person is signed in to`, cls: 'MOCK', severity: 'minor', evidence: row.shot, note: 'src/components/Sidebar.tsx (status pill)' });
  });

  // ── 5. new note ────────────────────────────────────────────────────────────────────────────────
  await rec.step('New note → a real session on the server', async (row) => {
    const p = a.page;
    await p.getByRole('link', { name: 'New note' }).click();
    await a.settle();
    await p.locator('#note-title').fill(NOTE.title);
    await p.locator('#note-body').fill(NOTE.body);
    row.shot = await a.shot('note-written');
    const save = p.locator('form.note button[type="submit"]');
    if (await save.isDisabled()) throw new Error(`Save is disabled with a title and a body typed. Screen says: ${(await a.text('[role="alert"]')) || 'nothing'}`);
    const t0 = Date.now();
    await save.click();
    // With local AI: "reading your note on this Mac…" then a confirm step. Without: filed as written.
    const outcome = await Promise.race([
      p.waitForFunction(() => /#\/sessions\//.test(location.hash), null, { timeout: 150_000 }).then(() => 'filed'),
      p.getByRole('button', { name: /^Save (with|note)/ }).waitFor({ timeout: 150_000 }).then(() => 'confirm'),
    ]).catch(() => 'stuck');
    if (outcome === 'confirm') {
      row.shot = await a.shot('note-extracted');
      rec.finding({ screen: 'New note', item: 'local extraction proposed a summary and facts', cls: 'REAL', evidence: row.shot });
      await p.getByRole('button', { name: /^Save (with|note)/ }).click();
      await p.waitForFunction(() => /#\/sessions\//.test(location.hash), null, { timeout: 60_000 });
    }
    await a.settle();
    row.shot = await a.shot('note-saved');
    if (outcome === 'stuck' || !/\/sessions\//.test(a.route())) throw new Error(`saving never finished: ${(await a.text('[role="alert"]')) || (await a.text('.sfoot')).replace(/\s+/g, ' ')}`);
    sessionId = a.route().split('/')[2];
    created.sessionIds.push(sessionId);
    const took = Date.now() - t0;

    const remote = await api(tokenA, 'GET', `/v1/sessions/${sessionId}`);
    if (remote.status !== 200) throw new Error(`the session the app shows does not exist on the server: GET /v1/sessions/${sessionId} → ${remote.status}`);
    const turns = remote.data?.turns ?? [];
    const memories = remote.data?.memories ?? [];
    for (const m of memories) created.memoryIds.push(m.id);
    rec.finding({ screen: 'New note', item: `session exists on the server (title "${remote.data.session.title}", ${turns.length} turn, status ${remote.data.session.status})`, cls: 'REAL', evidence: row.shot, note: `saved in ${(took / 1000).toFixed(1)} s · GET /v1/sessions/${sessionId} → 200` });
    if (took > 5_000 && outcome === 'filed')
      rec.finding({ screen: 'New note', item: `Save took ${(took / 1000).toFixed(1)} s behind "reading your note on this Mac…" — local extraction was attempted with no usable local model, failed, and the note was filed as written`, cls: 'BROKEN', severity: 'major', owner: 'onboarding', evidence: row.shot, note: 'src/api/bridge.ts localAi.available() only checks the IPC exists; main log: "spawn …/llama-server ENOENT" (src/main/local-ai/supervisor.ts)' });
    if (!turns.some((t) => (t.content ?? '').includes(run))) rec.finding({ screen: 'New note', item: 'the note text did not reach the server as a turn', cls: 'BROKEN', severity: 'blocker', evidence: row.shot });
    // "Save to: Personal" must mean the personal space — not another private space that may be shared.
    const filedIn = (await api(tokenA, 'GET', `/v1/projects/${remote.data.session.project_id}`)).data;
    if (filedIn?.slug !== 'personal')
      rec.finding({ screen: 'New note', item: `"Save to: Personal" filed the note in "${filedIn?.name ?? remote.data.session.project_id}" (slug ${filedIn?.slug ?? '?'})`, cls: 'BROKEN', severity: 'blocker', evidence: row.shot, note: 'GET /v1/projects/personal is ambiguous once a person owns two private projects (server project-scope.service.ts resolvePersonalProjectId)' });
    rec.finding({
      screen: 'New note',
      item: memories.length ? `${memories.length} context item(s) saved with the session` : 'the note was saved with ZERO context: nothing was extracted here and the server extracted nothing either, so search and every connected tool will never find it',
      cls: memories.length ? 'REAL' : 'BROKEN',
      severity: memories.length ? 'ok' : 'blocker',
      evidence: row.shot,
      note: memories.length ? '' : 'src/screens/NewNote.tsx:72-75 — when local extraction returns nothing the note is filed with no facts and no fallback',
    });
    const side = await a.text('nav.sidebar');
    rec.finding({ screen: 'Sidebar', item: side.includes(NOTE.title) ? 'the new session appears in the sidebar' : 'the new session does NOT appear in the sidebar', cls: side.includes(NOTE.title) ? 'REAL' : 'BROKEN', severity: side.includes(NOTE.title) ? 'ok' : 'blocker', evidence: row.shot });
  });

  // ── 6. ⌘K ──────────────────────────────────────────────────────────────────────────────────────
  await rec.step('⌘K search finds the note (real recall)', async (row) => {
    const p = a.page;
    const t0 = Date.now();
    await p.keyboard.press('Control+k');
    const input = p.getByRole('combobox');
    await input.waitFor({ timeout: 5_000 });
    await input.fill(NOTE.query);
    // The server indexes asynchronously; give recall a fair window before calling it broken.
    let found = false;
    for (let i = 0; i < 8 && !found; i++) {
      await sleep(2_500);
      found = await paletteHas(a, `Decision ${run}`, 'Context');
      if (!found) await input.fill(`${NOTE.query}${' '.repeat(i + 1)}`); // retype → the palette asks again
    }
    row.shot = await a.shot('palette');
    const results = await a.text('#palette-results');
    const recalls = (await a.requests(t0)).filter((r) => r.path === '/v1/memories/recall');
    const direct = await api(tokenA, 'POST', '/v1/memories/recall', { query: NOTE.query, limit: 10 });
    const serverHas = (direct.data ?? []).some((m) => (m.content ?? '').includes(run));
    const hits = MOCK_MARKERS.filter((m) => results.includes(m));
    if (hits.length) rec.finding({ screen: '⌘K', item: `sample results in search: ${hits.join(', ')}`, cls: 'MOCK', severity: 'blocker', evidence: row.shot });
    rec.finding({
      screen: '⌘K',
      item: found ? 'the note is found by meaning' : `the note just saved is not found ("${results.replace(/\s+/g, ' ').slice(0, 80)}")`,
      cls: found ? 'REAL' : 'BROKEN',
      severity: found ? 'ok' : 'blocker',
      evidence: row.shot,
      note: `POST /v1/memories/recall ×${recalls.length} → ${[...new Set(recalls.map((r) => r.status))].join(',') || 'never sent'}; asked directly, the server ${serverHas ? 'returns it' : 'returns nothing either'}`,
    });
    // By title, too: people remember what they called a note.
    await input.fill(NOTE.title);
    let byTitle = false;
    for (let i = 0; i < 6 && !byTitle; i++) {
      await sleep(1_000);
      byTitle = await a.page.locator('#palette-results [role="group"][aria-label="Sessions"] [role="option"]').allInnerTexts().then((r) => r.some((t) => t.includes(NOTE.title)), () => false);
    }
    const titleShot = await a.shot('palette-title');
    rec.finding({ screen: '⌘K', item: byTitle ? 'the note is found by its title, under Sessions' : 'typing the note’s exact title does not find the session', cls: byTitle ? 'REAL' : 'BROKEN', severity: byTitle ? 'ok' : 'major', evidence: titleShot, note: 'src/api/http.ts recall() — session titles' });
    if (found || byTitle) {
      await a.page.locator('#palette-results [role="option"]').filter({ hasText: NOTE.title }).first().click();
      await a.settle();
      const opened = a.route().includes(sessionId);
      rec.finding({ screen: '⌘K', item: opened ? 'choosing the result opens the session' : `choosing the result went to ${a.route()}`, cls: opened ? 'REAL' : 'BROKEN', severity: opened ? 'ok' : 'major', evidence: await a.shot('palette-opened') });
    } else await p.keyboard.press('Escape');
  });

  // ── 7. the session's tabs ──────────────────────────────────────────────────────────────────────
  await rec.step('Open the session: Summary / Context / Transcript / Access', async (row) => {
    if (!sessionId) throw new Error('no session was created');
    for (const tab of ['summary', 'context', 'transcript', 'access']) {
      await a.goto(`/sessions/${sessionId}${tab === 'summary' ? '' : `/${tab}`}`);
      row.shot = await a.shot(`session-${tab}`);
      const text = await a.text('main');
      await classifyMock(a, `Session · ${tab}`, row.shot, { selector: 'main' });
      if (tab === 'summary') rec.finding({ screen: 'Session · summary', item: text.includes(run) ? 'summary text is the note' : 'summary is empty or not the note', cls: text.includes(run) ? 'REAL' : 'BROKEN', severity: text.includes(run) ? 'ok' : 'major', evidence: row.shot });
      if (tab === 'summary') {
        const foot = await a.text('footer.sfoot');
        const m = foot.match(/retrievable from (\d+) connected tools?/);
        if (m && Number(m[1]) > 0) rec.finding({ screen: 'Session · footer', item: `"retrievable from ${m[1]} connected tools" — a brand-new account has connected nothing; the number counts the sample connectors`, cls: 'MOCK', severity: 'major', owner: 'integrations', evidence: row.shot, note: 'src/screens/SessionView.tsx:104 (listConnectors → mock fallback)' });
      }
      if (tab === 'context') {
        const n = Number((text.match(/Context · (\d+)/) ?? [])[1] ?? -1);
        rec.finding({ screen: 'Session · context', item: n > 0 ? `${n} context item(s)` : '"Nothing worth keeping was found in this session." — for a note that states a decision, a fact and an action', cls: n > 0 ? 'REAL' : 'BROKEN', severity: n > 0 ? 'ok' : 'blocker', evidence: row.shot });
      }
      if (tab === 'transcript') rec.finding({ screen: 'Session · transcript', item: text.includes(run) ? 'the note text, from the server' : 'transcript does not show the note', cls: text.includes(run) ? 'REAL' : 'BROKEN', severity: text.includes(run) ? 'ok' : 'major', evidence: row.shot });
      if (tab === 'access') rec.finding({ screen: 'Session · access', item: text.includes(A.name) ? 'the owner row is the signed-in person' : 'the owner row is missing', cls: text.includes(A.name) ? 'REAL' : 'BROKEN', severity: text.includes(A.name) ? 'ok' : 'major', evidence: row.shot });
    }
  });

  // ── 8. share with a second account ─────────────────────────────────────────────────────────────
  await rec.step('Share the session by email with a second account', async (row) => {
    const su = SEEDED.length === 2
      ? { status: 200, data: { token: SEEDED[1] } }
      : REUSE
      ? await api('', 'POST', '/v1/auth/login', { email: B.email, password: PASSWORD, client: 'cli' })
      : await api('', 'POST', '/v1/auth/signup', { email: B.email, password: PASSWORD, display_name: B.name, client: 'cli' });
    if (su.status !== (EXISTING ? 200 : 201)) throw new Error(`could not ${REUSE ? 'sign in to' : 'create'} the second account over the API: ${su.status} ${JSON.stringify(su.error)}`);
    tokenB = su.data.token;
    if (!REUSE) created.emails.push(B.email);
    const meB = (await api(tokenB, 'GET', '/v1/me')).data;
    Object.assign(B, { email: meB?.email || B.email, name: meB?.display_name || B.name });
    const p = a.page;
    await a.goto(`/sessions/${sessionId}/access`);
    const t0 = Date.now();
    await p.locator('#invite').fill(B.email);
    await p.getByRole('button', { name: 'Invite', exact: true }).click();
    await p.locator('#invite-hint').waitFor({ timeout: 20_000 });
    await a.settle();
    row.shot = await a.shot('shared');
    const hint = await a.text('#invite-hint');
    const put = (await a.requests(t0)).find((r) => r.method === 'PUT' && r.path.includes('/grants'));
    const list = await a.text('[aria-label="People and teams with access"]');
    const ok = put?.status >= 200 && put?.status < 300 && list.includes(B.name);
    rec.finding({ screen: 'Session · access', item: ok ? `shared with ${B.email} as reader; they appear in the list by name` : `sharing failed: "${hint}"`, cls: ok ? 'REAL' : 'BROKEN', severity: ok ? 'ok' : 'blocker', evidence: row.shot, note: `PUT ${put?.path ?? '(no request)'} → ${put?.status ?? '-'}; "${hint}"` });
    const header = await p.waitForFunction(() => /you and 1 person/.test(document.querySelector('.shead__meta')?.textContent ?? ''), null, { timeout: 8_000 }).then(() => true, () => false);
    rec.finding({ screen: 'Session · header', item: header ? 'the header now reads "you and 1 person"' : `the header still reads "${(await a.text('.shead__meta')).replace(/\s+/g, ' ')}" after sharing`, cls: header ? 'REAL' : 'BROKEN', severity: header ? 'ok' : 'minor', evidence: await a.shot('shared-header') });
  });

  // ── 8b. a space for the team: create it, share it, file a note in it ─────────────────────────────
  let spaceId = '';
  await rec.step('New space → share it with the teammate → file a note in it', async (row) => {
    const p = a.page;
    await a.goto('/spaces');
    const btn = p.getByRole('button', { name: 'New space' });
    if (await btn.isDisabled()) throw new Error('"New space" is disabled — a person cannot create a space to share with a team');
    await btn.click();
    await p.locator('#new-space').fill(SPACE.name);
    const t0 = Date.now();
    await p.getByRole('button', { name: 'Create', exact: true }).click();
    await p.waitForFunction(() => /#\/spaces\/[^/]+\/access/.test(location.hash), null, { timeout: 20_000 });
    await a.settle();
    spaceId = a.route().split('/')[2];
    const made = (await a.requests(t0)).find((r) => r.method === 'POST' && r.path === '/v1/projects');
    const remote = await api(tokenA, 'GET', `/v1/projects/${spaceId}`);
    rec.finding({ screen: 'Spaces · new space', item: remote.status === 200 ? `"${remote.data?.name}" created on the server and opened at its Access panel` : 'the space the app shows does not exist on the server', cls: remote.status === 200 ? 'REAL' : 'BROKEN', severity: remote.status === 200 ? 'ok' : 'blocker', evidence: await a.shot('space-created'), note: `POST /v1/projects → ${made?.status ?? 'not sent'}; GET /v1/projects/${spaceId.slice(0, 8)}… → ${remote.status}` });

    await p.locator('#invite').fill(B.email);
    await p.getByRole('button', { name: 'Invite', exact: true }).click();
    await p.locator('#invite-hint').waitFor({ timeout: 20_000 });
    await a.settle();
    row.shot = await a.shot('space-shared');
    const grants = await api(tokenA, 'GET', `/v1/projects/${spaceId}/grants`);
    const shared = (grants.data ?? []).some((g) => g.subject?.email === B.email);
    rec.finding({ screen: 'Space · access', item: shared ? `space shared with ${B.email}` : `sharing the space failed: "${await a.text('#invite-hint')}"`, cls: shared ? 'REAL' : 'BROKEN', severity: shared ? 'ok' : 'blocker', evidence: row.shot });

    await p.getByRole('link', { name: 'New note' }).click();
    await a.settle();
    await p.locator('#note-title').fill(TEAM_NOTE.title);
    await p.locator('#note-body').fill(TEAM_NOTE.body);
    await p.getByRole('button', { name: /^Save to space:/ }).click();
    await p.getByRole('option', { name: SPACE.name }).click();
    row.shot = await a.shot('team-note-written');
    await p.locator('form.note button[type="submit"]').click();
    const outcome = await Promise.race([
      p.waitForFunction(() => /#\/sessions\//.test(location.hash), null, { timeout: 150_000 }).then(() => 'filed'),
      p.getByRole('button', { name: /^Save (with|note)/ }).waitFor({ timeout: 150_000 }).then(() => 'confirm'),
    ]).catch(() => 'stuck');
    if (outcome === 'confirm') {
      await p.getByRole('button', { name: /^Save (with|note)/ }).click();
      await p.waitForFunction(() => /#\/sessions\//.test(location.hash), null, { timeout: 60_000 });
    }
    await a.settle();
    row.shot = await a.shot('team-note-saved');
    const teamSession = a.route().split('/')[2];
    const s = await api(tokenA, 'GET', `/v1/sessions/${teamSession}`);
    created.sessionIds.push(teamSession);
    const inSpace = s.data?.session?.project_id === spaceId;
    rec.finding({ screen: 'New note · Save to', item: inSpace ? `filed in "${SPACE.name}" with ${s.data?.memories?.length ?? 0} context item(s)` : `filed in ${s.data?.session?.project_id ?? '(nothing)'} instead of the chosen space`, cls: inSpace ? 'REAL' : 'BROKEN', severity: inSpace && s.data?.memories?.length ? 'ok' : 'blocker', evidence: row.shot });
  });

  // ── 9. the second person, in a second copy of the app ──────────────────────────────────────────
  await rec.step('Second app instance: the teammate signs in, sees the shared session, recalls', async (row) => {
    b = new AppInstance('B');
    await b.launch();
    await b.settle();
    const p = b.page;
    if (SEEDED.length === 2) await b.seedToken(tokenB, B.email);
    else {
      await p.locator('input[name="email"]').fill(B.email);
      await p.locator('input[name="password"]').fill(PASSWORD);
      await p.getByRole('button', { name: 'Sign in', exact: true }).click();
      await p.waitForFunction(() => !location.hash.includes('/welcome'), null, { timeout: 30_000 }).catch(() => undefined);
      await b.settle();
    }
    row.shot = await b.shot('teammate-landing');
    if (b.route().includes('/welcome')) throw new Error(`the teammate could not sign in: ${await b.text('[role="alert"]')}`);
    if (b.route().startsWith('/onboarding')) {
      rec.finding({ screen: 'Onboarding', item: 'signing in to an existing account on a new Mac goes through onboarding', cls: 'REAL', evidence: row.shot, owner: 'onboarding' });
      // Walked once already as the owner; the teammate skips it (its models step would start a 4 GB download).
      await p.evaluate(() => localStorage.setItem('openkt.onboarded', '1'));
      await b.goto('/');
    }
    await classifyMock(b, 'Teammate · landing', row.shot);

    // Can they see it? Sidebar lists "mine" only, so the honest places are Spaces and search.
    const side = await b.text('nav.sidebar');
    await b.goto('/spaces');
    row.shot = await b.shot('teammate-spaces');
    const spacesText = await b.text('main');
    const direct = await api(tokenB, 'GET', `/v1/sessions/${sessionId}`);
    await b.goto(`/sessions/${sessionId}`);
    const shotOpen = await b.shot('teammate-open-shared-session');
    const canOpen = (await b.text('main')).includes(NOTE.title);
    const discoverable = side.includes(NOTE.title) || spacesText.includes(NOTE.title);
    rec.finding({
      screen: 'Teammate · shared session',
      item: discoverable ? 'the shared session is visible to the teammate' : `the teammate has NO way to find the shared session: it is not in their sidebar, not under Spaces, and there is no "Shared with me" anywhere${canOpen ? ' (it opens only if you already know its URL)' : ''}`,
      cls: discoverable ? 'REAL' : 'BROKEN',
      severity: discoverable ? 'ok' : 'blocker',
      owner: discoverable ? 'qa' : 'server',
      evidence: discoverable ? row.shot : `${row.shot}, ${shotOpen}`,
      note: `server says GET /v1/sessions/${sessionId.slice(0, 8)}… as the teammate → ${direct.status}; sidebar asks listSessions({mine:true}) and the server lists sessions per project — src/components/Sidebar.tsx:37, src/api/http.ts listSessions`,
    });

    // The session header must not tell the teammate "only you".
    const hdr = (await b.text('.shead__meta')).replace(/\s+/g, ' ');
    if (canOpen) rec.finding({ screen: 'Teammate · shared session', item: /shared with you/.test(hdr) ? 'the header says "shared with you"' : `the header reads "${hdr}" for someone who was given access`, cls: /shared with you/.test(hdr) ? 'REAL' : 'BROKEN', severity: /shared with you/.test(hdr) ? 'ok' : 'minor', evidence: shotOpen });

    // The shared space: listed, opens, shows the team note.
    if (spaceId) {
      const listed = spacesText.includes(SPACE.name);
      await b.goto(`/spaces/${spaceId}`);
      const spaceShot = await b.shot('teammate-shared-space');
      const hasNote = (await b.text('main')).includes(TEAM_NOTE.title);
      rec.finding({ screen: 'Teammate · shared space', item: listed && hasNote ? `"${SPACE.name}" is under Spaces and shows the note filed in it` : `shared space ${listed ? 'listed' : 'NOT listed'} under Spaces; note ${hasNote ? 'shown' : 'NOT shown'}`, cls: listed && hasNote ? 'REAL' : 'BROKEN', severity: listed && hasNote ? 'ok' : 'blocker', evidence: `${row.shot}, ${spaceShot}` });
    }

    // Recall as the teammate.
    await b.goto('/');
    await b.settle();
    await p.keyboard.press('Control+k');
    const input = p.getByRole('combobox');
    const opened = await input.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    let found = false;
    if (opened) {
      for (let i = 0; i < 4 && !found; i++) {
        await input.fill(`${NOTE.query}${' '.repeat(i)}`);
        await sleep(2_500);
        found = await paletteHas(b, `Decision ${run}`, 'Context');
      }
    }
    row.shot = await b.shot('teammate-recall');
    const viaApi = await api(tokenB, 'POST', '/v1/memories/recall', { query: NOTE.query, limit: 10 });
    const serverHas = (viaApi.data ?? []).some((m) => (m.content ?? '').includes(run));
    rec.finding({
      screen: 'Teammate · ⌘K',
      item: found ? 'the teammate recalls the shared context' : opened ? 'the teammate cannot recall the shared context' : '⌘K did not open for the teammate',
      cls: found ? 'REAL' : 'BROKEN',
      severity: found ? 'ok' : 'blocker',
      owner: found || serverHas ? 'qa' : 'server',
      evidence: row.shot,
      note: `asked directly as the teammate, the server ${serverHas ? 'returns it' : `returns ${viaApi.data?.length ?? 0} items, none of them the note`} (status ${viaApi.status})`,
    });
    await p.keyboard.press('Escape').catch(() => undefined);

    // What was shared through a space is found with ⌘K, with no space named.
    if (spaceId) {
      await p.keyboard.press('Control+k');
      const box = p.getByRole('combobox');
      let teamFound = false;
      if (await box.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
        for (let i = 0; i < 6 && !teamFound; i++) {
          await box.fill(`${TEAM_NOTE.query}${' '.repeat(i)}`);
          await sleep(2_500);
          teamFound = await paletteHas(b, `Heron Freight ${run}`);
        }
      }
      const shot = await b.shot('teammate-recall-space');
      const direct = await api(tokenB, 'POST', '/v1/memories/recall', { query: TEAM_NOTE.query, limit: 10, project_id: spaceId });
      rec.finding({ screen: 'Teammate · ⌘K (shared space)', item: teamFound ? 'the teammate recalls the note filed in the shared space' : 'the teammate cannot recall the note filed in the shared space', cls: teamFound ? 'REAL' : 'BROKEN', severity: teamFound ? 'ok' : 'blocker', evidence: shot, note: `POST /v1/memories/recall {project_id: the space} as the teammate → ${direct.status}, ${(direct.data ?? []).length} item(s)` });
      await p.keyboard.press('Escape').catch(() => undefined);
    }
  });
  if (b) await b.close();

  // ── 10. the rest of the app ────────────────────────────────────────────────────────────────────
  await rec.step('Spaces', async (row) => {
    await a.goto('/spaces');
    row.shot = await a.shot('spaces');
    const text = await a.text('main');
    await classifyMock(a, 'Spaces', row.shot, { selector: 'main' });
    rec.finding({ screen: 'Spaces', item: /Personal/.test(text) ? 'the personal space, from GET /v1/projects' : 'no spaces listed', cls: /Personal/.test(text) ? 'REAL' : 'BROKEN', severity: /Personal/.test(text) ? 'ok' : 'major', evidence: row.shot });
    const newSpace = a.page.getByRole('button', { name: 'New space' });
    if ((await newSpace.count()) && (await newSpace.isDisabled())) rec.finding({ screen: 'Spaces', item: '"New space" is permanently disabled — a person can never create a space, so sharing a space with a team is impossible from the app', cls: 'BROKEN', severity: 'major', evidence: row.shot, note: 'src/screens/SpacesList.tsx · the server has POST /v1/projects' });
    if (spaceId && !text.includes(SPACE.name)) rec.finding({ screen: 'Spaces', item: `the space created in this run ("${SPACE.name}") is not listed`, cls: 'BROKEN', severity: 'major', evidence: row.shot });
    const m = text.match(/(\d+) pages · (\d+) sessions/);
    if (m && Number(m[2]) < 1) rec.finding({ screen: 'Spaces', item: `the personal space says "${m[0]}" after a note was filed in it`, cls: 'BROKEN', severity: 'minor', evidence: row.shot });
    await a.page.getByRole('link', { name: /Personal/ }).first().click();
    await a.settle();
    row.shot = await a.shot('space-personal');
    const sp = await a.text('main');
    await classifyMock(a, 'Space', row.shot, { selector: 'main' });
    rec.finding({ screen: 'Space', item: sp.includes(NOTE.title) ? 'recent sessions lists the note' : 'recent sessions does not list the note', cls: sp.includes(NOTE.title) ? 'REAL' : 'BROKEN', severity: sp.includes(NOTE.title) ? 'ok' : 'major', evidence: row.shot });
    rec.finding({ screen: 'Space · pages', item: /No pages yet/.test(sp) ? '"No pages yet." — the server has no pages endpoint' : 'pages listed', cls: /No pages yet/.test(sp) ? 'EMPTY-HONEST' : 'REAL', evidence: row.shot });
  });

  await rec.step('Pages', async (row) => {
    // There is no page to click for a real account; the route still answers from sample data.
    await a.goto('/pages/p-northgate-pricing'); // a sample page's id, typed in: it must not open for a real account
    row.shot = await a.shot('page-direct');
    const hits = await classifyMock(a, 'Page (direct URL)', row.shot, { selector: 'main', severity: 'major', labelledSeverity: 'minor' });
    if (!hits.length) rec.finding({ screen: 'Page (direct URL)', item: `a sample page's address says "${(await a.text('main')).replace(/\s+/g, ' ').slice(0, 90)}"`, cls: 'EMPTY-HONEST', evidence: row.shot });
  });

  await rec.step('Skills', async (row) => {
    await a.goto('/skills');
    row.shot = await a.shot('skills');
    const hits = await classifyMock(a, 'Skills', row.shot, { owner: 'skills', selector: 'main' });
    if (!hits.length) {
      const t = (await a.text('main')).replace(/\s+/g, ' ');
      const empty = /no skills|nothing here|write your first/i.test(t);
      rec.finding({ screen: 'Skills', item: empty ? `empty and says so: "${t.slice(0, 80)}"` : `no sample skills; shows "${t.slice(0, 80)}"`, cls: empty ? 'EMPTY-HONEST' : 'REAL', owner: 'skills', evidence: row.shot, note: `GET /v1/skills → ${(await a.requests()).filter((r) => r.path.startsWith('/v1/skills')).map((r) => r.status).slice(-1)[0] ?? 'not requested'}` });
    }
  });

  for (const [section, owner] of [['connectors', 'integrations'], ['access', 'integrations'], ['models', 'onboarding'], ['hotkeys', 'qa'], ['workspace', 'qa'], ['account', 'qa']]) {
    await rec.step(`Settings · ${section}`, async (row) => {
      row.severity = 'major';
      await a.goto(`/settings/${section}`);
      row.shot = await a.shot(`settings-${section}`);
      const text = await a.text('main');
      const hits = await classifyMock(a, `Settings · ${section}`, row.shot, { owner, selector: 'main' });
      if (section === 'connectors' && /connected/.test(text) && !hits.length) rec.finding({ screen: 'Settings · connectors', item: 'tools shown as "connected" for an account that connected nothing', cls: 'MOCK', severity: 'blocker', owner, evidence: row.shot });
      if (section === 'workspace') rec.finding({ screen: 'Settings · workspace', item: /your account/.test(text) ? '"now showing your account"' : 'does not say which data is showing', cls: 'REAL', evidence: row.shot });
      if (section === 'account') rec.finding({ screen: 'Settings · account', item: text.includes(A.email) ? 'name and email from GET /v1/me' : 'the signed-in person is not shown', cls: text.includes(A.email) ? 'REAL' : 'BROKEN', severity: text.includes(A.email) ? 'ok' : 'major', evidence: row.shot });
      if (section === 'models') rec.finding({ screen: 'Settings · models', item: `"${[...text.matchAll(/About [\d.]+ [GM]B[^\n]*|paused at \d+%[^\n]*|\d+ of \d+[^\n]*|[^\n]*not in this build/g)].map((m) => m[0].trim()).join(' · ')}" — read from this Mac's model store`, cls: 'REAL', owner: 'onboarding', evidence: row.shot });
      if (section === 'hotkeys' && process.platform !== 'darwin') rec.finding({ screen: 'Settings · hotkeys', item: 'global shortcuts: not exercised (needs macOS Accessibility/Input Monitoring — TCC)', cls: 'EMPTY-HONEST', evidence: row.shot, note: 'skipped' });
    });
  }

  // ── 11. the server goes away ───────────────────────────────────────────────────────────────────
  await rec.step('Server unreachable: a visible error with Retry, never sample data', async (row) => {
    await a.setOffline(true);
    await a.goto('/spaces');
    await a.page.reload();
    await a.page.waitForSelector('#root > *', { timeout: 20_000 });
    await a.settle(1500);
    row.shot = await a.shot('offline');
    const text = await a.text();
    const hits = MOCK_MARKERS.filter((m) => text.includes(m));
    const retry = await a.page.getByRole('button', { name: /retry|try again/i }).count();
    const says = /can.?t reach|couldn.?t reach|unreachable|offline|no connection|connect to/i.test(text);
    if (hits.length) rec.finding({ screen: 'Offline', item: `with the server unreachable the app silently shows sample data: ${hits.join(', ')}`, cls: 'MOCK', severity: 'blocker', evidence: row.shot });
    if (/ERR_[A-Z_]+|invoking remote method/.test(text)) rec.finding({ screen: 'Offline', item: 'a raw transport error is shown to the person', cls: 'BROKEN', severity: 'minor', evidence: row.shot, note: (text.match(/[^\n]*ERR_[A-Z_]+[^\n]*/) ?? [''])[0] });
    rec.finding({
      screen: 'Offline',
      item: says && retry ? 'says the server cannot be reached and offers Retry' : `server unreachable → ${says ? 'an error line but no Retry' : 'no explanation at all'}; the sidebar is just empty, as if the account had no data`,
      cls: says && retry ? 'REAL' : 'BROKEN',
      severity: says && retry ? 'ok' : 'blocker',
      evidence: row.shot,
      note: says && retry ? `"${(text.match(/Can.t reach[^\n]*/) ?? [''])[0]}" + Retry` : 'src/components/Sidebar.tsx drops sessions.error; src/components/bits.tsx ErrorNote has no Retry; src/app/AppRoutes.tsx Home redirects to /new on error',
    });
    await a.setOffline(false);
    if (retry) {
      await a.page.getByRole('button', { name: /retry|try again/i }).first().click();
      await a.settle(1500);
      row.shot = await a.shot('offline-recovered');
      const back = await a.text();
      rec.finding({ screen: 'Offline', item: /Personal/.test(back) || back.includes(NOTE.title) ? 'Retry brings the real data back' : 'Retry did not recover', cls: /Personal/.test(back) || back.includes(NOTE.title) ? 'REAL' : 'BROKEN', severity: /Personal/.test(back) || back.includes(NOTE.title) ? 'ok' : 'major', evidence: row.shot });
    } else {
      await a.page.reload();
      await a.settle();
    }
  });

  // ── 12. quit and relaunch ──────────────────────────────────────────────────────────────────────
  await rec.step('Quit and relaunch with the same user-data-dir: still signed in', async (row) => {
    const dir = a.userDataDir;
    await a.close();
    const again = new AppInstance('A2', dir);
    await again.launch();
    await again.settle(1200);
    row.shot = await again.shot('relaunch');
    const route = again.route();
    const side = await again.text('nav.sidebar');
    const ok = !route.includes('/welcome') && side.includes(NOTE.title);
    rec.finding({ screen: 'Relaunch', item: ok ? `still signed in; opens ${route}; the note is in the sidebar` : `relaunch opened ${route}${side.includes(NOTE.title) ? '' : ' without the saved note'}`, cls: ok ? 'REAL' : 'BROKEN', severity: ok ? 'ok' : 'blocker', evidence: row.shot });
    if (route.startsWith('/onboarding')) rec.finding({ screen: 'Relaunch', item: 'onboarding shows again on relaunch', cls: 'BROKEN', severity: 'major', owner: 'onboarding', evidence: row.shot });

    // ── 13. sign out, sign back in ────────────────────────────────────────────────────────────────
    if (SEEDED.length === 2) {
      rec.finding({ screen: 'Sign out', item: 'not exercised with pre-issued tokens (signing out would revoke them; signing back in is what the server was refusing)', cls: 'EMPTY-HONEST', evidence: row.shot });
      a.console.push(...again.console);
      await again.close();
      return;
    }
    await again.goto('/settings/account');
    await again.page.getByRole('button', { name: 'Sign out' }).click();
    await again.page.waitForFunction(() => location.hash.includes('/welcome'), null, { timeout: 15_000 });
    await again.settle();
    const out = await again.shot('signed-out');
    const dead = await api(tokenA, 'GET', '/v1/me');
    rec.finding({ screen: 'Sign out', item: `back on the sign-in screen with the email remembered; the old token is ${dead.status === 401 ? 'revoked on the server' : `STILL VALID (GET /v1/me → ${dead.status})`}`, cls: dead.status === 401 ? 'REAL' : 'BROKEN', severity: dead.status === 401 ? 'ok' : 'major', evidence: out });
    const email = await again.page.locator('input[name="email"]').inputValue();
    if (email !== A.email) rec.finding({ screen: 'Sign out', item: `the email field is "${email}", not the address that just signed out`, cls: 'BROKEN', severity: 'minor', evidence: out });
    await again.page.locator('input[name="email"]').fill(A.email);
    await again.page.locator('input[name="password"]').fill(PASSWORD);
    await again.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await again.page.waitForFunction(() => !location.hash.includes('/welcome'), null, { timeout: 30_000 }).catch(() => undefined);
    await again.settle(1200);
    row.shot = await again.shot('signed-back-in');
    tokenA = await again.token();
    const side2 = await again.text('nav.sidebar');
    const back = !again.route().includes('/welcome') && side2.includes(NOTE.title);
    rec.finding({ screen: 'Sign back in', item: back ? `lands on ${again.route()} with the note still there` : `after signing back in: route ${again.route()}, note ${side2.includes(NOTE.title) ? 'present' : 'missing'}`, cls: back ? 'REAL' : 'BROKEN', severity: back ? 'ok' : 'blocker', evidence: row.shot });
    a.console.push(...again.console);
    await again.close();
  });
} catch (e) {
  rec.finding({ screen: 'Harness', item: 'the journey crashed', cls: 'BROKEN', severity: 'blocker', note: String(e?.stack ?? e).slice(0, 600) });
} finally {
  await a.close().catch(() => undefined);
  if (b) await b.close().catch(() => undefined);
}

// ── clean up what the server lets us clean up ─────────────────────────────────────────────────────
const cleanup = { memoriesDeleted: 0, sessionsDeleted: 0, accountsLeft: created.emails, note: 'The server has no account-deletion endpoint; accounts created here remain. Set OPENKT_E2E_ACCOUNTS to reuse a pair instead.' };
try {
  if (!tokenA && SEEDED.length !== 2) tokenA = (await api('', 'POST', '/v1/auth/login', { email: A.email, password: PASSWORD, client: 'cli' })).data?.token ?? '';
  for (const id of tokenA ? created.sessionIds : []) {
    const s = await api(tokenA, 'GET', `/v1/sessions/${id}`);
    for (const m of s.data?.memories ?? []) if ((await api(tokenA, 'DELETE', `/v1/memories/${m.id}`)).status < 300) cleanup.memoriesDeleted++;
    // There is no DELETE /v1/sessions/:id; the call is kept so the count turns non-zero the day it exists.
    if ((await api(tokenA, 'DELETE', `/v1/sessions/${id}`)).status < 300) cleanup.sessionsDeleted++;
  }
  if (SEEDED.length !== 2) for (const t of [tokenA, tokenB]) if (t) await api(t, 'POST', '/v1/auth/logout');
} catch {
  /* best effort */
}

// ── summary ───────────────────────────────────────────────────────────────────────────────────────
const consoleErrors = a.console.filter((c) => c.type !== 'warning');
if (consoleErrors.length) rec.finding({ screen: 'Renderer console', item: `${consoleErrors.length} error(s): ${[...new Set(consoleErrors.map((c) => c.text.slice(0, 120)))].slice(0, 3).join(' ¦ ')}`, cls: 'BROKEN', severity: 'minor', evidence: 'console-A.json' });

const count = (k, v) => rec.findings.filter((f) => f[k] === v).length;
const summary = {
  run,
  server: SERVER,
  app: PACKAGED || 'dev build (dist-electron/)',
  platform: process.platform,
  at: new Date().toISOString(),
  totals: {
    steps: rec.steps.length,
    stepsFailed: rec.steps.filter((s) => s.status === 'fail').length,
    blocker: count('severity', 'blocker'),
    major: count('severity', 'major'),
    minor: count('severity', 'minor'),
    REAL: count('cls', 'REAL'),
    MOCK: count('cls', 'MOCK'),
    BROKEN: count('cls', 'BROKEN'),
    'EMPTY-HONEST': count('cls', 'EMPTY-HONEST'),
  },
  blockersByOwner: Object.fromEntries([...new Set(rec.findings.filter((f) => f.severity === 'blocker').map((f) => f.owner))].map((o) => [o, rec.findings.filter((f) => f.severity === 'blocker' && f.owner === o).length])),
  accounts: created.emails,
  reusedAccounts: EXISTING ? [A.email, B.email] : [],
  cleanup,
  steps: rec.steps,
  findings: rec.findings,
};
writeFileSync(join(ARTIFACTS, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(`\n── ${summary.totals.blocker} blocker · ${summary.totals.major} major · ${summary.totals.minor} minor · REAL ${summary.totals.REAL} · MOCK ${summary.totals.MOCK} · BROKEN ${summary.totals.BROKEN} · EMPTY-HONEST ${summary.totals['EMPTY-HONEST']}`);
for (const f of rec.findings.filter((x) => x.severity === 'blocker')) console.log(`   BLOCKER (${f.owner}) ${f.screen} — ${f.item}`);
console.log(`   artifacts: ${ARTIFACTS}`);
process.exit(summary.totals.blocker > 0 ? 1 : 0);
