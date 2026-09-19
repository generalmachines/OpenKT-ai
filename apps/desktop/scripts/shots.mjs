/**
 * npm run shots — screenshots every route into apps/desktop/shots/.
 *
 * Builds nothing itself: it serves the current `dist/` with `vite preview`
 * (run `npm run build:renderer` first, or pass --dev to use the dev server),
 * drives a headless Chromium through playwright-core, and checks that Geist
 * actually loaded and that nothing overflows horizontally.
 *
 * CHROMIUM_PATH overrides the browser binary (no browser is downloaded).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
const dev = process.argv.includes('--dev');
const port = dev ? 5173 : 4173;
const base = `http://localhost:${port}`;
const executablePath =
  process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell');

const APP = { width: 1280, height: 800 };
const CAPTURE = { width: 760, height: 460 };
const S = '/sessions/s-northgate-pricing';

/** A stand-in for the Electron bridge's local AI, so the note confirmation can be shot in a browser. */
function fakeLocalAi() {
  localStorage.setItem('openkt.api', JSON.stringify({ adapter: 'mock' }));
  window.openkt = {
    platform: 'browser',
    app: { onNavigate: () => () => undefined, hotkeys: async () => [], openMain: async () => undefined },
    capture: { onEvent: () => () => undefined },
    localAi: {
      extractNote: async () => ({
        status: 'ok',
        title: 'Northgate pricing follow-up',
        summary: 'Northgate wants per-store pricing across 40 stores. The revised deck goes out Friday; legacy POS export is still an open risk.',
        facts: [
          { kind: 'decision', statement: 'Quote Northgate per store, not per seat', quote: 'quote per store' },
          { kind: 'action', statement: 'Send the revised deck to Ana by Friday', quote: 'deck by Friday' },
          { kind: 'question', statement: 'Can the legacy POS export nightly?', quote: 'legacy POS' },
        ],
      }),
    },
  };
}

/** The real server's 401 body, without touching the network (a refused fetch would log a console error). */
function refusingServer() {
  window.fetch = async () =>
    new Response(JSON.stringify({ data: null, error: { code: 'unauthorized', message: 'invalid or expired token', details: null, request_id: 'shot' }, meta: null }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}

/** name, route, viewport, optional steps before the shot, artboard it mirrors, optional init script */
const SHOTS = [
  ['00-connect', '/connect', APP, null, 'Onboarding.dc.html'],
  [
    '00b-connect-failed',
    '/connect',
    APP,
    async (p) => {
      await p.getByLabel('Access token').fill('okt_pat_example');
      await p.getByRole('button', { name: 'Test connection' }).click();
      await p.getByRole('alert').waitFor();
    },
    null,
    refusingServer,
  ],
  ['01-onboarding-1-sign-in', '/onboarding/1', APP, null, null],
  ['02-onboarding-2-connect-tools', '/onboarding/2', APP, null, 'Onboarding.dc.html'],
  ['03-onboarding-3-models', '/onboarding/3', APP, null, null],
  ['04-session-summary', S, APP, null, 'Main.dc.html'],
  ['05-session-context', `${S}/context`, APP, null, null],
  ['06-session-transcript', `${S}/transcript`, APP, null, null],
  ['07-session-access', `${S}/access`, APP, null, 'Access.dc.html'],
  ['08-session-access-role-menu', `${S}/access`, APP, async (p) => p.getByRole('button', { name: /Role for Ana Reyes/ }).click(), null],
  ['09-new-note', '/new', APP, null, null],
  [
    '09b-new-note-confirm',
    '/new',
    APP,
    async (p) => {
      await p.getByLabel('Note', { exact: true }).fill('Call with Ana at Northgate. They want us to quote per store, 40 stores. I owe her the revised deck by Friday. Open question: can their legacy POS export nightly?');
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await p.getByLabel('Summary').waitFor();
    },
    null,
    fakeLocalAi,
  ],
  ['10-spaces', '/spaces', APP, null, null],
  ['11-space', '/spaces/sp-northgate', APP, null, 'Space.dc.html'],
  ['12-space-access', '/spaces/sp-northgate/access', APP, null, null],
  ['13-page', '/pages/p-northgate-pricing', APP, null, 'Page.dc.html'],
  ['14-skills', '/skills', APP, null, 'Skills.dc.html'],
  ['15-settings-connectors', '/settings/connectors', APP, null, 'Connectors.dc.html'],
  ['16-settings-connectors-menu', '/settings/connectors', APP, async (p) => p.getByRole('button', { name: /New ChatGPT sessions/ }).click(), null],
  ['17-settings-access-defaults', '/settings/access', APP, null, null],
  ['18-settings-models', '/settings/models', APP, null, 'Models.dc.html'],
  ['19-settings-hotkeys', '/settings/hotkeys', APP, null, null],
  ['20-settings-workspace', '/settings/workspace', APP, null, null],
  ['21-settings-account', '/settings/account', APP, null, null],
  ['22-palette', S, APP, async (p) => p.keyboard.press('Control+k'), null],
  [
    '23-palette-filtered',
    S,
    APP,
    async (p) => {
      await p.keyboard.press('Control+k');
      await p.getByRole('combobox').fill('legacy pos');
    },
    null,
  ],
  ['24-capture-voice', '/capture/voice', CAPTURE, null, 'Capture-Voice.dc.html'],
  ['25-capture-meeting', '/capture/meeting', CAPTURE, null, 'Capture-Meeting.dc.html'],
  ['26-capture-screenshot', '/capture/screenshot', CAPTURE, null, 'Capture-Screenshot.dc.html'],
  ['27-session-summary-960x640', S, { width: 960, height: 640 }, null, null],
];

async function waitForServer(url, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start at ${url}`);
}

/** Layout checks that a screenshot alone can hide. Runs in the page. */
function audit() {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) problems.push(`page overflows horizontally by ${doc.scrollWidth - doc.clientWidth}px`);
  for (const el of document.querySelectorAll('#root *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const label = `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ')[0]}`;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    // crushed flex children: text-bearing element squeezed to nothing
    if (hasText && (r.width < 2 || r.height < 2)) problems.push(`${label} is crushed to ${Math.round(r.width)}×${Math.round(r.height)}`);
    // clipped text, unless the element opts into an ellipsis
    if (hasText && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible')
      problems.push(`${label} clips its text (${el.scrollWidth} > ${el.clientWidth})`);
    // anything sticking out past the right edge of the window
    if (r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('.sr-only')) problems.push(`${label} extends ${Math.round(r.right - window.innerWidth)}px past the window`);
  }
  return [...new Set(problems)].slice(0, 8);
}

async function main() {
  if (!existsSync(executablePath)) throw new Error(`Chromium not found at ${executablePath}. Set CHROMIUM_PATH.`);
  if (!dev && !existsSync(join(root, 'dist/index.html'))) throw new Error('dist/ is missing — run `npm run build:renderer` first.');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const vite = join(root, 'node_modules/.bin/vite');
  const bin = existsSync(vite) ? vite : join(root, '../../node_modules/.bin/vite');
  const server = spawn(bin, dev ? ['--port', String(port), '--strictPort'] : ['preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  let failed = false;
  try {
    await waitForServer(base);
    const browser = await chromium.launch({ executablePath });
    const report = [];
    for (const [name, route, viewport, steps, artboard, init] of SHOTS) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage();
      if (init) await page.addInitScript(init);
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`${base}/#${route}`);
      await page.waitForSelector('#root > *');
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && !/loading…/.test(document.body.innerText));
      await page.evaluate(() => document.fonts.ready);
      if (steps) await steps(page);
      await page.waitForTimeout(150);

      const fonts = await page.evaluate(() => ({
        geist: document.fonts.check("14px 'Geist Variable'") && [...document.fonts].some((f) => f.family.includes('Geist Variable') && f.status === 'loaded'),
        mono: [...document.fonts].some((f) => f.family.includes('Geist Mono Variable') && f.status === 'loaded'),
        body: getComputedStyle(document.body).fontFamily.split(',')[0],
      }));
      const problems = await page.evaluate(audit);
      if (!fonts.geist) problems.push('Geist did not load');
      if (errors.length) problems.push(...errors.map((e) => `console: ${e}`));
      await page.screenshot({ path: join(out, `${name}.png`) });
      await context.close();

      report.push({ name, route, viewport: `${viewport.width}x${viewport.height}`, artboard, fonts, problems });
      if (problems.length) failed = true;
      console.log(`${problems.length ? '✗' : '✓'} ${name}  ${route}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
    }
    await browser.close();
    writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${report.length} screenshots → ${out}`);
  } finally {
    server.kill();
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
