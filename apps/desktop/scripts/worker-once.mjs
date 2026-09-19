#!/usr/bin/env node
/**
 * Runs the on-device worker (src/main/worker) under plain Node, outside Electron: the same claim →
 * local model → complete loop the app runs, against any OpenKT server and any OpenAI-compatible
 * model endpoint (a llama.cpp `llama-server` with Qwen3.5, as the app bundles).
 *
 *   npm run build:main
 *   OPENKT_SERVER_URL=https://api.openkt.ai OPENKT_EMAIL=… OPENKT_PASSWORD=… \
 *   OPENKT_LLM_BASE_URL=http://127.0.0.1:8080/v1 node scripts/worker-once.mjs
 *
 * OPENKT_TOKEN may replace email + password. It works through the queue until the server has
 * nothing more for this account, then prints what it did and how long each agent took.
 * OPENKT_WORKER_OUT=<dir> also writes every posted result as JSON there.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LocalWorker } = require(join(root, 'dist-electron/main/worker/worker.js'));
const { HttpJobsServer } = require(join(root, 'dist-electron/main/worker/protocol.js'));
const { loadAgentsModule, loadPipelineModule } = require(join(root, 'dist-electron/main/worker/modules.js'));

const server = (process.env.OPENKT_SERVER_URL ?? '').replace(/\/+$/, '');
const llmUrl = process.env.OPENKT_LLM_BASE_URL ?? '';
const model = process.env.OPENKT_LLM_MODEL ?? 'Qwen3.5-4B';
const maxJobs = Number(process.env.OPENKT_MAX_JOBS ?? 20);
const out = process.env.OPENKT_WORKER_OUT;
if (!server || !llmUrl) {
  console.error('Set OPENKT_SERVER_URL and OPENKT_LLM_BASE_URL (and OPENKT_TOKEN, or OPENKT_EMAIL + OPENKT_PASSWORD).');
  process.exit(2);
}

let token = process.env.OPENKT_TOKEN ?? '';
if (!token) {
  const res = await fetch(`${server}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.OPENKT_EMAIL, password: process.env.OPENKT_PASSWORD, client: 'cli' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  token = body.data.token;
  console.log(`signed in as ${body.data.user.email}`);
}

const http = new HttpJobsServer(() => server, async () => token);
const jobs = {
  claim: (kinds, worker) => http.claim(kinds, worker),
  lookup: (id, facts) => http.lookup(id, facts),
  fail: (id, error, retry) => http.fail(id, error, retry),
  async complete(id, result) {
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${id}.result.json`), JSON.stringify(result, null, 2));
    }
    const applied = await http.complete(id, result);
    if (out) writeFileSync(join(out, `${id}.applied.json`), JSON.stringify(applied, null, 2));
    return applied;
  },
};

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`;
let lastLine = '';
const worker = new LocalWorker({
  server: jobs,
  model,
  workerName: () => `worker-once · ${model}`,
  modules: async () => ({ agents: await loadAgentsModule(), pipeline: await loadPipelineModule() }),
  llm: async (agents) => new agents.OpenAiCompatibleClient({ baseUrl: llmUrl, model: 'local', timeoutMs: 300_000 }),
  readiness: async () => ({ signedIn: true, modelReady: true }),
  log: (line) => console.log(`${stamp()} ${line}`),
});
worker.onChange((s) => {
  const line = s.current ? `${s.current.space} · ${s.current.step}` : s.state;
  if (line !== lastLine) console.log(`${stamp()} ${line}${s.lastError ? ` — ${s.lastError}` : ''}`);
  lastLine = line;
});

let done = 0;
while (done < maxJobs && (await worker.tick())) done += 1;
const status = worker.status();
console.log(`\n${done} job(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s. Last: ${JSON.stringify(status.last)}${status.lastError ? `\nLast error: ${status.lastError}` : ''}`);
process.exit(status.state === 'error' ? 1 : 0);
