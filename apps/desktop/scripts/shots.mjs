/**
 * npm run shots — screenshots every route into apps/desktop/shots/.
 *
 * Builds nothing itself: it serves the current `dist/` with `vite preview`
 * (run `npm run build:renderer` first, or pass --dev to use the dev server),
 * drives a headless Chromium through playwright-core, and checks that Geist
 * actually loaded and that nothing overflows horizontally.
 *
 * CHROMIUM_PATH overrides the browser binary (no browser is downloaded).
 * `--only=<text>` shoots just the shots whose name contains it.
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
/** `--only=skill` shoots just the matching names (and keeps the other PNGs). */
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '';
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

/**
 * A stand-in for the native capture IPC (voice / screenshot / models). The microphone is an oscillator, so the
 * REAL recorder runs in Chromium: getUserMedia → AudioWorklet → 16 kHz PCM16 → voice.chunk. `window.__chunks`
 * collects the byte length of every chunk so the shot can assert audio actually flowed.
 */
function fakeCaptureIpc() {
  localStorage.setItem('openkt.api', JSON.stringify({ adapter: 'mock' }));
  const mode = new URLSearchParams(location.hash.split('?')[1] ?? '').get('fake') ?? '';
  window.__chunks = [];
  navigator.mediaDevices.getUserMedia = async () => {
    if (mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const gain = ctx.createGain();
    const depth = ctx.createGain();
    osc.frequency.value = 220;
    lfo.frequency.value = 3;
    gain.gain.value = 0.25;
    depth.gain.value = 0.2;
    lfo.connect(depth).connect(gain.gain);
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    lfo.start();
    return dest.stream;
  };
  const px = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="128"><rect width="192" height="128" fill="#f1efe9"/><rect x="14" y="16" width="90" height="10" rx="3" fill="#b9b6ad"/><rect x="14" y="40" width="48" height="70" rx="5" fill="#fff" stroke="#d0cec8"/><rect x="72" y="40" width="48" height="70" rx="5" fill="#fff" stroke="#d0cec8"/><rect x="130" y="40" width="48" height="70" rx="5" fill="#fff" stroke="#b4532a"/></svg>');
  window.openkt = {
    platform: 'browser',
    app: { onNavigate: () => () => undefined, hotkeys: async () => [], openMain: async () => undefined },
    capture: { onEvent: (l) => ((window.__captureEvent = l), () => undefined) },
    overlay: { close: async () => void (window.__closed = true) },
    voice: {
      begin: async () => 'v1',
      chunk: (_id, buf) => void window.__chunks.push(buf.byteLength),
      end: async () =>
        mode === 'empty'
          ? { empty: true }
          : { text: 'What if every new store got an onboarding kit — a printed shelf map, the first week’s planogram, and a QR code to the floor plan.', segments: [], language: 'en', duration_ms: 14000 },
      toSession: async () => ({ status: 'ok', title: 'Per-store onboarding kit', summary: 'An onboarding kit for every new store.', facts: [{ kind: 'idea', statement: 'Give every new store a printed shelf map', quote: 'printed shelf map' }] }),
      cancel: () => undefined,
    },
    screenshot: {
      capture: async () =>
        mode === 'nothing'
          ? { image_path: px, title: '', description: '', visible_text: '', entities: [], facts: [] }
          : { image_path: px, title: 'Competitor pricing page — three tiers, per-store billing on the top tier', description: 'Competitor pricing page — three tiers, per-store billing on the top tier.', visible_text: 'Starter $49 · Growth $149 · Enterprise per store', entities: [], facts: [] },
    },
    models: { status: async () => ({ models: [{ role: 'llm', id: 'qwen3.5-4b', file: 'q.gguf', path: '', totalBytes: 3e9, receivedBytes: mode === 'models' ? 1e9 : 3e9, state: mode === 'models' ? 'downloading' : 'ready' }] }), ensure: async () => ({ ok: true }), onProgress: () => () => undefined },
  };
}

/**
 * A stand-in for the first-run halves of the Electron bridge: macOS permissions and the on-device AI
 * download, in the state named by `?fake=` (models) and `?perms=` (permissions) in the route. Nothing
 * here reaches a Mac: the shots show what each state looks like, not that macOS agrees.
 */
function fakeFirstRun() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const mode = q.get('fake') ?? 'fresh';
  localStorage.setItem('openkt.api', JSON.stringify({ adapter: 'mock' }));
  if (q.get('onboarded') === '1') localStorage.setItem('openkt.onboarded', '1');
  if (mode === 'tried') localStorage.setItem('openkt.onboarding', JSON.stringify({ step: 5, skipped: [3], tried: ['voice', 'note'], startedAt: Date.now() }));
  const GiB = 1024 ** 3;
  const big = { embed: 639150592, llm: 2740937888, whisper: 574041195, mmproj: 672423616 };
  const small = { embed: 639150592, llm: 1280835840, whisper: 487601967, mmproj: 668227264 };
  const sizes = mode === 'small' ? small : big;
  const ready = ['ready', 1];
  const at =
    {
      downloading: { embed: ready, llm: ['downloading', 0.38] },
      small: { embed: ready, llm: ['partial', 0.62] },
      error: { embed: ready, llm: ['error', 0.21] },
      tryit: { embed: ready, llm: ready, whisper: ['downloading', 0.46] },
      tried: { embed: ready, llm: ready, whisper: ready, mmproj: ready },
      ready: { embed: ready, llm: ready, whisper: ready, mmproj: ready },
      sidebar: { embed: ready, llm: ['downloading', 0.71] },
    }[mode] ?? {};
  const hf = (m) => `https://huggingface.co/${m}`;
  const tier = mode === 'small' ? '2B' : '4B';
  const about = {
    embed: { name: 'Qwen3-Embedding-0.6B', license: 'Apache-2.0', card: hf('Qwen/Qwen3-Embedding-0.6B') },
    llm: { name: `Qwen3.5-${tier}`, license: 'Apache-2.0', card: hf(`Qwen/Qwen3.5-${tier}`) },
    whisper: mode === 'small' ? { name: 'Whisper small', license: 'Apache-2.0', card: hf('openai/whisper-small') } : { name: 'Whisper large-v3-turbo', license: 'MIT', card: hf('openai/whisper-large-v3-turbo') },
    mmproj: { name: `Qwen3.5-${tier} vision`, license: 'Apache-2.0', card: hf(`Qwen/Qwen3.5-${tier}`) },
  };
  const rows = ['embed', 'llm', 'whisper', 'mmproj'].map((role) => {
    const [state, f] = at[role] ?? ['missing', 0];
    return { role, id: role, file: `${role}.gguf`, path: '', totalBytes: sizes[role], receivedBytes: Math.round(sizes[role] * f), state, ...about[role], ...(state === 'error' ? { error: 'gave up after 5 attempts: fetch failed' } : {}) };
  });
  const total = rows.reduce((n, r) => n + r.totalBytes, 0);
  const remaining = rows.reduce((n, r) => n + (r.state === 'ready' ? 0 : r.totalBytes - r.receivedBytes), 0);
  const info = {
    totalBytes: total,
    remainingBytes: remaining,
    freeBytes: mode === 'lowdisk' ? 2.1e9 : 212.4e9,
    neededBytes: remaining + GiB,
    enoughDisk: mode !== 'lowdisk',
    totalMemBytes: (mode === 'small' ? 8 : 16) * GiB,
    smallModel: mode === 'small',
    paused: mode === 'small',
    chosen: !['fresh', 'lowdisk', 'later'].includes(mode),
    bundled: { runtime: true, transcriber: true, textReader: true },
  };
  const none = { microphone: 'not-determined', screen: 'not-determined', accessibility: 'not-determined', systemAudio: 'not-determined', relaunchSuggested: false };
  const perms =
    {
      fresh: none,
      mixed: { microphone: 'granted', screen: 'denied', accessibility: 'not-determined', systemAudio: 'denied', relaunchSuggested: true },
      tryit: { microphone: 'granted', screen: 'not-determined', accessibility: 'granted', systemAudio: 'not-determined', relaunchSuggested: false },
      settings: { microphone: 'granted', screen: 'granted', accessibility: 'denied', systemAudio: 'granted', relaunchSuggested: false },
    }[q.get('perms') ?? 'fresh'] ?? none;
  window.openkt = {
    platform: 'darwin',
    app: {
      onNavigate: () => () => undefined,
      openMain: async () => undefined,
      hotkeys: async () => [
        { id: 'voice', display: 'fn', fallbackAccelerator: 'Control+Alt+Space', registered: true },
        { id: 'screenshot', display: '⌃⌥S', fallbackAccelerator: 'Control+Alt+S', registered: true },
      ],
      startCapture: async () => undefined,
    },
    capture: { onEvent: () => () => undefined },
    overlay: { close: async () => undefined },
    permissions: { status: async () => ({ ...perms }), request: async () => ({ ...perms }), openSettings: async () => undefined, onChange: () => () => undefined, relaunch: async () => undefined },
    models: {
      status: async () => ({ models: rows }),
      ensure: () => new Promise(() => undefined),
      onProgress: (l) => {
        const d = rows.find((r) => r.state === 'downloading');
        if (d) setTimeout(() => l({ ...d, bytesPerSec: 18.4e6, overall: 0 }), 30);
        return () => undefined;
      },
      setupInfo: async () => info,
      pause: async () => info,
      resume: async () => info,
    },
    localAi: { extractNote: async () => ({ status: 'noop' }) },
    voice: { begin: async () => 'v1', chunk: () => undefined, end: async () => ({}), toSession: async () => null, cancel: () => undefined },
  };
}

const VOICE_WIN = { width: 536, height: 244 };
const SHOT_WIN = { width: 536, height: 132 };

/** Waits until the real recorder has streamed at least a second of 16 kHz PCM16 in ~250 ms chunks. */
async function audioFlowed(p) {
  await p.waitForFunction(() => window.__chunks.length >= 4, null, { timeout: 8000 });
  const sizes = await p.evaluate(() => window.__chunks);
  if (!sizes.every((b) => b >= 8000 && b <= 16000 && b % 2 === 0)) throw new Error(`unexpected PCM chunk sizes: ${sizes.join(', ')}`);
}
const stopVoice = (p) => p.evaluate(() => window.__captureEvent({ type: 'voice.final', captureId: 'x', text: '', durationSec: 0 }));

/** name, route, viewport, optional steps before the shot, artboard it mirrors, optional init script */
const SHOTS = [
  // Sign-in runs against the stand-in that accepts anyone (src/api/auth.ts MockAuth): no server needed.
  ['00-welcome-signin', '/welcome', APP, async (p) => p.getByRole('button', { name: 'Continue with Google' }).waitFor(), null],
  [
    '00b-welcome-create-account',
    '/welcome',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'Continue with Google' }).waitFor();
      await p.getByRole('button', { name: 'Create an account' }).click();
      await p.getByLabel('Your name').fill('Ana Reyes');
      await p.getByLabel('Email').fill('ana@northgate.com');
      await p.getByLabel('Password').fill('a long enough password');
      await p.mouse.move(1, 1);
    },
    null,
  ],
  [
    '00c-welcome-error',
    '/welcome',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'Continue with Google' }).waitFor();
      await p.getByLabel('Email').fill('ana@northgate.com');
      await p.getByLabel('Password').fill('oops');
      await p.getByLabel('Password').press('Enter');
      await p.getByRole('alert').waitFor();
    },
    null,
  ],
  [
    '00d-welcome-advanced',
    '/welcome',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'Continue with Google' }).waitFor();
      await p.getByRole('button', { name: 'Using your own server?' }).click();
      await p.getByLabel('Server address').waitFor();
      await p.mouse.move(1, 1);
    },
    null,
  ],
  // In a browser there is nothing to allow, so step 2 hands straight over to step 3.
  ['02-onboarding-3-connect-tools', '/onboarding/2', APP, async (p) => p.getByRole('heading', { name: 'Connect your tools' }).waitFor(), 'Onboarding.dc.html'],
  ['03-onboarding-4-models-browser', '/onboarding/4', APP, null, null],
  ['04-session-summary', S, APP, null, 'Main.dc.html'],
  ['05-session-context', `${S}/context`, APP, null, null],
  ['06-session-transcript', `${S}/transcript`, APP, null, null],
  ['07-session-access', `${S}/access`, APP, null, 'Access.dc.html'],
  ['08-session-access-role-menu', `${S}/access`, APP, async (p) => p.getByRole('button', { name: /Role for Ana Reyes/ }).click(), null],
  [
    '08b-access-share-by-email',
    `${S}/access`,
    APP,
    async (p) => {
      await p.getByLabel('Invite by email').fill('ravi@example.com');
      await p.getByLabel('Invite by email').press('Enter');
      await p.getByText('Ravi Menon', { exact: true }).waitFor();
      await p.getByLabel('Invite by email').fill('dana@northgate.com');
      await p.getByRole('button', { name: 'Invite as: Reader' }).click();
      await p.getByRole('option', { name: 'Editor' }).click();
      await p.getByRole('button', { name: 'Invite', exact: true }).click();
      await p.getByText('Invited — hasn’t joined yet').waitFor();
    },
    null,
  ],
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
  [
    '14b-new-skill-dialog',
    '/skills',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'New skill' }).click();
      await p.getByLabel('Name').fill('Answer a pricing question');
      await p.mouse.move(1, 1);
    },
    null,
  ],
  ['14c-skill-read', '/skills/sk-marketing', APP, null, 'Skill.dc.html'],
  ['14d-skill-source', '/skills/sk-marketing', APP, async (p) => p.getByRole('button', { name: 'Source' }).click(), null],
  ['14e-skill-reference-file', '/skills/sk-marketing', APP, async (p) => p.getByRole('button', { name: /references\/voice\.md/ }).click(), null],
  ['14f-skill-edit', '/skills/sk-marketing/edit', APP, async (p) => p.getByLabel('Edit SKILL.md').waitFor(), 'Skill-Edit.dc.html'],
  [
    '14g-skill-edit-invalid',
    '/skills/sk-marketing/edit',
    APP,
    async (p) => {
      const editor = p.getByLabel('Edit SKILL.md');
      await editor.fill(`# Sharpen a marketing message\n\nRewrite the draft so it sounds like us.\n`);
      await p.getByRole('alert').waitFor();
    },
    null,
  ],
  ['14h-skill-version-view', '/skills/sk-marketing/versions/3', APP, async (p) => p.getByRole('button', { name: 'Restore this version' }).waitFor(), null],
  [
    '14i-skill-run-sheet',
    '/skills/sk-marketing',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'Run', exact: true }).click();
      await p.getByLabel('Your input').fill('We’re thrilled to unveil our revolutionary AI-powered planogram engine that seamlessly empowers retailers!');
    },
    null,
  ],
  ['14j-skill-reader', '/skills/sk-followup', APP, null, null],
  [
    '14k-skill-share',
    '/skills/sk-pr',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'Share' }).click();
      await p.getByLabel('Invite by email').fill('dana@northgate.com');
      await p.getByRole('button', { name: 'Invite', exact: true }).click();
      await p.getByText('Invited — hasn’t joined yet').waitFor();
    },
    null,
  ],
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
  ['28-overlay-voice-listening', '/overlay/voice', VOICE_WIN, audioFlowed, 'Capture-Voice.dc.html', fakeCaptureIpc],
  [
    '29-overlay-voice-review',
    '/overlay/voice',
    VOICE_WIN,
    async (p) => {
      await audioFlowed(p);
      await stopVoice(p);
      await p.getByRole('button', { name: 'Save', exact: true }).waitFor();
    },
    null,
    fakeCaptureIpc,
  ],
  [
    '30-overlay-voice-saved-models-pending',
    '/overlay/voice?fake=models',
    VOICE_WIN,
    async (p) => {
      await audioFlowed(p);
      await stopVoice(p);
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await p.getByText(/key points are pulled out/).waitFor();
    },
    null,
    fakeCaptureIpc,
  ],
  [
    '31-overlay-voice-empty',
    '/overlay/voice?fake=empty',
    VOICE_WIN,
    async (p) => {
      await audioFlowed(p);
      await stopVoice(p);
      await p.getByText(/Nothing was said/).waitFor();
    },
    null,
    fakeCaptureIpc,
  ],
  ['32-overlay-voice-mic-denied', '/overlay/voice?fake=denied', VOICE_WIN, async (p) => p.getByRole('alert').waitFor(), null, fakeCaptureIpc],
  ['33-overlay-screenshot', '/overlay/screenshot', SHOT_WIN, async (p) => p.getByRole('textbox', { name: 'Title' }).waitFor(), 'Capture-Screenshot.dc.html', fakeCaptureIpc],
  ['34-overlay-screenshot-nothing', '/overlay/screenshot?fake=nothing', SHOT_WIN, async (p) => p.getByRole('button', { name: 'Close' }).waitFor(), null, fakeCaptureIpc],
  ['27-session-summary-960x640', S, { width: 960, height: 640 }, null, null],
  ['27b-skill-edit-960x640', '/skills/sk-marketing/edit', { width: 960, height: 640 }, async (p) => p.getByLabel('Edit SKILL.md').waitFor(), null],
  // ── first run on a Mac (fake bridge: fakeFirstRun) ──
  ['35-onboarding-2-permissions', '/onboarding/2?perms=fresh', APP, async (p) => p.getByRole('button', { name: 'Allow: Microphone' }).waitFor(), 'Onboarding.dc.html', fakeFirstRun],
  ['36-onboarding-2-permissions-relaunch', '/onboarding/2?perms=mixed', APP, async (p) => p.getByRole('button', { name: 'Relaunch OpenKT' }).waitFor(), null, fakeFirstRun],
  ['37-onboarding-4-models-choice', '/onboarding/4?fake=fresh', APP, async (p) => p.getByRole('button', { name: 'Download models (4.6 GB)' }).waitFor(), null, fakeFirstRun],
  ['37b-onboarding-4-models-downloading', '/onboarding/4?fake=downloading', APP, async (p) => p.getByText(/MB\/s/).waitFor(), null, fakeFirstRun],
  ['38-onboarding-4-models-low-disk', '/onboarding/4?fake=lowdisk', APP, async (p) => p.getByRole('alert').waitFor(), null, fakeFirstRun],
  ['39-onboarding-4-models-small-mac-paused', '/onboarding/4?fake=small', APP, async (p) => p.getByRole('button', { name: 'Resume' }).waitFor(), null, fakeFirstRun],
  ['40-onboarding-4-models-error', '/onboarding/4?fake=error', APP, async (p) => p.getByRole('button', { name: 'Try again' }).waitFor(), null, fakeFirstRun],
  ['41-onboarding-5-try-it', '/onboarding/5?fake=tryit&perms=tryit', APP, async (p) => p.getByText(/Downloading the speech model/).waitFor(), null, fakeFirstRun],
  ['41b-onboarding-5-try-it-models-later', '/onboarding/5?fake=later&perms=settings', APP, async (p) => p.getByRole('button', { name: /Download speech model/ }).waitFor(), null, fakeFirstRun],
  [
    '42-onboarding-5-try-it-writing',
    '/onboarding/5?fake=ready&perms=settings',
    APP,
    async (p) => {
      await p.getByRole('button', { name: 'Write' }).click();
      await p.getByRole('textbox', { name: 'Note' }).fill('Call with Ana — she wants the revised deck by Friday.');
    },
    null,
    fakeFirstRun,
  ],
  ['43-onboarding-5-try-it-done', '/onboarding/5?fake=tried&perms=settings', APP, async (p) => p.getByText('2 of 3 tried. The menu bar has all of these any time.').waitFor(), null, fakeFirstRun],
  ['44-settings-permissions', '/settings/permissions?perms=settings&fake=ready&onboarded=1', APP, async (p) => p.getByRole('button', { name: 'Open System Settings: Accessibility' }).waitFor(), null, fakeFirstRun],
  ['45-settings-models-live', '/settings/models?fake=downloading&onboarded=1', APP, async (p) => p.getByText(/MB\/s/).waitFor(), 'Models.dc.html', fakeFirstRun],
  ['45b-settings-models-not-downloaded', '/settings/models?fake=fresh&onboarded=1', APP, async (p) => p.getByRole('button', { name: 'Download models (4.6 GB)' }).waitFor(), 'Models.dc.html', fakeFirstRun],
  ['46-sidebar-setup-progress', `${S}?fake=sidebar&onboarded=1`, APP, async (p) => p.getByRole('link', { name: /Setting up on-device AI/ }).waitFor(), null, fakeFirstRun],
  ['46b-sidebar-download-entry', `${S}?fake=fresh&onboarded=1`, APP, async (p) => p.getByRole('link', { name: /Download on-device AI/ }).waitFor(), null, fakeFirstRun],
  ['47-overlay-voice-finishing-setup', '/overlay/voice?fake=sidebar', VOICE_WIN, async (p) => p.getByText(/Finishing setup/).waitFor(), null, fakeFirstRun],
  ['48-overlay-voice-needs-speech', '/overlay/voice?fake=later', VOICE_WIN, async (p) => p.getByRole('button', { name: /Download the speech model/ }).waitFor(), null, fakeFirstRun],
  ['49-new-note-models-offer', '/new?fake=fresh&onboarded=1', APP, async (p) => p.getByText(/Pulling out the key points/).waitFor(), null, fakeFirstRun],
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
    // clipped text, unless the element opts into an ellipsis (a code box that scrolls sideways is not clipping)
    const scrollsSideways = el.matches('textarea, pre') && (cs.overflowX === 'auto' || cs.overflowX === 'scroll');
    if (hasText && !scrollsSideways && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible')
      problems.push(`${label} clips its text (${el.scrollWidth} > ${el.clientWidth})`);
    // anything sticking out past the right edge of the window
    if (r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('.sr-only')) problems.push(`${label} extends ${Math.round(r.right - window.innerWidth)}px past the window`);
  }
  return [...new Set(problems)].slice(0, 8);
}

async function main() {
  if (!existsSync(executablePath)) throw new Error(`Chromium not found at ${executablePath}. Set CHROMIUM_PATH.`);
  if (!dev && !existsSync(join(root, 'dist/index.html'))) throw new Error('dist/ is missing — run `npm run build:renderer` first.');
  if (!only) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const vite = join(root, 'node_modules/.bin/vite');
  const bin = existsSync(vite) ? vite : join(root, '../../node_modules/.bin/vite');
  const server = spawn(bin, dev ? ['--port', String(port), '--strictPort'] : ['preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  let failed = false;
  try {
    await waitForServer(base);
    const browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
    const report = [];
    for (const [name, route, viewport, steps, artboard, init] of SHOTS.filter(([name]) => !only || name.includes(only))) {
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
    if (!only) writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
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
