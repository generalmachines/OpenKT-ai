#!/usr/bin/env node
/**
 * `npm run e2e` — the loop. Builds the app (unless it is testing a packaged one), then drives
 * e2e/journey.mjs against OPENKT_E2E_SERVER (default https://api.openkt.ai). On Linux without a
 * display the journey is wrapped in xvfb-run. Exit code: the journey's (1 = at least one BLOCKER).
 *
 *   OPENKT_E2E_SERVER      server to test against
 *   OPENKT_E2E_APP         a packaged binary (…/OpenKT.app/Contents/MacOS/OpenKT); skips the build
 *   OPENKT_E2E_SKIP_BUILD  1 = use dist/ and dist-electron/ as they are
 *   OPENKT_E2E_ARTIFACTS   where screenshots, logs and summary.json go (default e2e/artifacts)
 *   OPENKT_E2E_ACCOUNTS    <id>: sign in as e2e-<id>-a / e2e-<id>-b instead of creating two accounts
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const journey = join(here, 'journey.mjs');

if (!process.env.OPENKT_E2E_APP && process.env.OPENKT_E2E_SKIP_BUILD !== '1') {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const built = spawnSync(npm, ['run', 'build'], { cwd: join(here, '..'), stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('The app did not build; the journey was not run.');
    process.exit(built.status ?? 1);
  }
}

const headless = process.platform === 'linux' && !process.env.DISPLAY;
if (headless && spawnSync('which', ['xvfb-run']).status !== 0) {
  console.error('xvfb-run is not installed and there is no DISPLAY. Install xvfb (apt-get install -y xvfb) or run under a desktop session.');
  process.exit(2);
}
const [cmd, args] = headless ? ['xvfb-run', ['-a', '--server-args=-screen 0 1440x900x24', process.execPath, journey]] : [process.execPath, [journey]];
const r = spawnSync(cmd, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
