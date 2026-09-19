/**
 * The end-to-end harness: launches the REAL Electron app (dev build or a packaged
 * binary) and gives the journey a small vocabulary — screenshot, read the screen,
 * record a finding, read what main actually sent to the server.
 *
 * Nothing here stubs the server. The only instrumentation is read-only:
 *   - `session.webRequest.onCompleted/onErrorOccurred` in main logs every request the
 *     main-process proxy (src/main/net.ts) makes on the renderer's behalf;
 *   - the renderer console and main's stdout/stderr are captured to files.
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');

export const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(HERE, '..');
export const ARTIFACTS = process.env.OPENKT_E2E_ARTIFACTS ? resolve(process.env.OPENKT_E2E_ARTIFACTS) : join(HERE, 'artifacts');
export const SERVER = (process.env.OPENKT_E2E_SERVER || 'https://api.openkt.ai').replace(/\/+$/, '');
/** A packaged binary (…/OpenKT.app/Contents/MacOS/OpenKT). Unset: the dev build in dist-electron/. */
export const PACKAGED = process.env.OPENKT_E2E_APP || '';

/** Strings that exist only in src/api/mock/seed.ts. Any of them on a signed-in screen is sample data. */
export const MOCK_MARKERS = [
  'Northgate', 'Pratham Bhatnagar', 'Ana Reyes', 'Ravi Menon', 'Ojas Sinha', 'Lena Fischer', 'Deepwork',
  'Fix auth refresh storm', 'per-store onboarding kit', 'Q4 launch messaging', 'Inbox triage', 'Competitor pricing page',
  'Hiring plan notes', 'Draft proposal v1', 'Intro call notes', 'Sales team', 'Everyone in Deepwork',
  'Sharpen a marketing message', 'Follow-up after a customer call', 'Write a pull request description', 'Weekly update for founders',
  'remote MCP · signed in', 'personal agent · access token', 'Parakeet (streaming)', 'Omnilingual ASR',
];

export const rand = () => Math.random().toString(36).slice(2, 10);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resetArtifacts() {
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });
}

/** Direct calls to the server, outside the app — the journey's ground truth. */
export async function api(token, method, path, body) {
  const r = await fetch(`${SERVER}${path}`, {
    method,
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* 204 */
  }
  return { status: r.status, data: j?.data ?? null, error: j?.error ?? null, meta: j?.meta ?? null };
}

export class Recorder {
  constructor() {
    this.steps = [];
    this.findings = [];
    this.n = 0;
  }
  /** cls: REAL | MOCK | EMPTY-HONEST | BROKEN.  severity: blocker | major | minor | ok.  owner: who fixes it. */
  finding(f) {
    const row = { screen: '', item: '', cls: 'REAL', severity: 'ok', owner: 'qa', evidence: '', note: '', ...f };
    this.findings.push(row);
    const tag = row.severity === 'ok' ? '  ok ' : row.severity.toUpperCase().padEnd(5);
    console.log(`   ${tag} [${row.cls}] ${row.screen} — ${row.item}${row.note ? ` · ${row.note}` : ''}`);
    return row;
  }
  async step(title, fn) {
    const id = String(++this.n).padStart(2, '0');
    const row = { id, title, status: 'pass', error: '', ms: 0 };
    this.steps.push(row);
    console.log(`\n[${id}] ${title}`);
    const t0 = Date.now();
    try {
      await fn(row);
    } catch (e) {
      row.status = 'fail';
      row.error = (e && e.message ? e.message : String(e)).split('\n').slice(0, 4).join(' | ');
      console.log(`   FAIL ${row.error}`);
      this.finding({ screen: title, item: 'step could not be completed', cls: 'BROKEN', severity: row.severity ?? 'blocker', owner: row.owner ?? 'qa', evidence: row.shot ?? '', note: row.error });
    }
    row.ms = Date.now() - t0;
    return row;
  }
}

/** One running copy of the app with its own user-data-dir. */
/** Every user-data-dir a run made; `removeUserDataDirs()` deletes them (models downloaded by mistake included). */
const made = new Set();
export function removeUserDataDirs() {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.clear();
}

export class AppInstance {
  constructor(label, userDataDir) {
    this.label = label;
    this.userDataDir = userDataDir ?? mkdtempSync(join(tmpdir(), `openkt-e2e-${label}-`));
    made.add(this.userDataDir);
    this.console = [];
    this.shotN = 0;
    this.mainLog = join(ARTIFACTS, `main-${label}.log`);
  }

  async launch(extraEnv = {}) {
    const args = [`--user-data-dir=${this.userDataDir}`];
    // Containers and CI runners have no usable chrome-sandbox helper; a GUI macOS runner does.
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
    const opts = PACKAGED ? { executablePath: PACKAGED, args } : { executablePath: require('electron'), args: [APP_DIR, ...args] };
    this.app = await _electron.launch({
      ...opts,
      cwd: APP_DIR,
      timeout: 60_000,
      env: {
        ...process.env,
        OPENKT_NO_AUTO_MODELS: '1', // a first launch would otherwise start a ~4 GB download
        OPENKT_QUIT_ON_CLOSE: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        ...extraEnv,
      },
    });
    const proc = this.app.process();
    proc.stdout?.on('data', (d) => appendFileSync(this.mainLog, d));
    proc.stderr?.on('data', (d) => appendFileSync(this.mainLog, d));

    // Read-only request log, in main. `net.fetch` rides the default session, so webRequest sees the proxy's calls.
    await this.app.evaluate(({ session }) => {
      const g = globalThis;
      g.__e2eRequests = [];
      const ses = session.defaultSession;
      ses.webRequest.onCompleted((d) => {
        if (/^https?:/.test(d.url)) g.__e2eRequests.push({ at: Date.now(), method: d.method, url: d.url, status: d.statusCode });
      });
      ses.webRequest.onErrorOccurred((d) => {
        if (/^https?:/.test(d.url)) g.__e2eRequests.push({ at: Date.now(), method: d.method, url: d.url, status: 0, error: d.error });
      });
    });

    this.page = await this.app.firstWindow();
    this.page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.console.push({ at: Date.now(), type: m.type(), text: m.text().slice(0, 500), route: this.route() });
    });
    this.page.on('pageerror', (e) => this.console.push({ at: Date.now(), type: 'pageerror', text: String(e.message).slice(0, 500), route: this.route() }));
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector('#root > *', { timeout: 30_000 });
    return this;
  }

  route() {
    try {
      return new URL(this.page.url()).hash.replace(/^#/, '') || '/';
    } catch {
      return '';
    }
  }

  async goto(route) {
    await this.page.evaluate((r) => (window.location.hash = r), route);
    await this.settle();
  }

  /** Wait for the screen to stop loading: no aria-busy, no "loading…" rows, network quiet for a beat. */
  async settle(ms = 600) {
    await sleep(150);
    await this.page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && !/loading…/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => undefined);
    await sleep(ms);
  }

  async shot(name) {
    const file = `${this.label}-${String(++this.shotN).padStart(2, '0')}-${name}.png`;
    await this.page.screenshot({ path: join(ARTIFACTS, file) });
    return file;
  }

  text(selector = 'body') {
    return this.page.locator(selector).first().innerText({ timeout: 5_000 }).catch(() => '');
  }

  async mockHits(selector = 'body') {
    const t = await this.text(selector);
    return MOCK_MARKERS.filter((m) => t.includes(m));
  }

  /** Requests main made since `since` (ms epoch), paths only. */
  async requests(since = 0) {
    const all = await this.app.evaluate(() => globalThis.__e2eRequests ?? []);
    return all.filter((r) => r.at >= since).map((r) => ({ ...r, path: r.url.replace(/^https?:\/\/[^/]+/, '') }));
  }

  /** The signed-in token, read the way main reads it (src/main/net.ts). */
  async token() {
    return this.app.evaluate(({ app, safeStorage }) => {
      const fs = process.mainModule.require('node:fs');
      const path = process.mainModule.require('node:path');
      const file = path.join(app.getPath('userData'), 'secrets', 'server-token.bin');
      if (!fs.existsSync(file)) return '';
      const raw = fs.readFileSync(file);
      try {
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      } catch {
        return raw.toString('utf8');
      }
    });
  }

  /**
   * Start signed in with a token issued elsewhere, stored exactly where main keeps it (src/main/net.ts
   * secureSet), then reload. For runs where the server refuses sign-ins (rate limit): no auth call is made.
   */
  async seedToken(token, email) {
    await this.app.evaluate(({ app, safeStorage }, value) => {
      const fs = process.mainModule.require('node:fs');
      const path = process.mainModule.require('node:path');
      const dir = path.join(app.getPath('userData'), 'secrets');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'server-token.bin'), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8'), { mode: 0o600 });
    }, token);
    await this.page.evaluate(([baseUrl, mail]) => localStorage.setItem('openkt.api', JSON.stringify({ adapter: 'http', baseUrl, email: mail })), [SERVER, email]);
    await this.page.reload();
    await this.page.waitForSelector('#root > *', { timeout: 30_000 });
    await this.goto('/'); // the reloaded page is still on #/welcome, which does not redirect by itself
  }

  /** Cut the app off from the server (and restore it) without touching app code. */
  async setOffline(offline) {
    await this.app.evaluate(({ session }, off) => {
      session.defaultSession.webRequest.onBeforeRequest(off ? { urls: ['http://*/*', 'https://*/*'] } : null, off ? (_d, cb) => cb({ cancel: true }) : null);
    }, offline);
  }

  async close() {
    writeFileSync(join(ARTIFACTS, `console-${this.label}.json`), JSON.stringify(this.console, null, 2));
    try {
      writeFileSync(join(ARTIFACTS, `requests-${this.label}.json`), JSON.stringify(await this.requests(), null, 2));
    } catch {
      /* app already gone */
    }
    await this.app?.close().catch(() => undefined);
  }
}
