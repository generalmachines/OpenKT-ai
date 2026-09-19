#!/usr/bin/env node
/**
 * The proof, run on macOS in CI (and runnable anywhere llama-server exists): the SAME
 * main-process modules the app uses, outside Electron.
 *   OPENKT_LLAMA_DIR   dir with llama-server          (default resources/llama)
 *   OPENKT_MODELS_DIR  where models are cached        (default ~/models)
 *   OPENKT_MODEL_TIER  2b | 4b                        (default 2b — never load the 4B on a CI runner)
 *   OPENKT_SMOKE_REPORT report path                   (default ./smoke-local-ai-report.json)
 *   OPENKT_LLAMA_EXTRA_ARGS extra llama-server args, space separated
 * Requires `npm run build:main` first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, totalmem, cpus, platform, arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const main = (p) => require(join(root, 'dist-electron/main', p));
const { loadManifest, chooseModels, chooseTier, modelUrl, localName } = main('models/manifest.js');
const { downloadFile, sha256File } = main('models/downloader.js');
const { LlamaLocalAi, EMBED_DIM } = main('local-ai/local-ai.js');
const { extractNote, loadAgents } = main('local-ai/agents.js');

const llamaDir = resolve(process.env.OPENKT_LLAMA_DIR || join(root, 'resources/llama'));
const modelsDir = resolve(process.env.OPENKT_MODELS_DIR || join(homedir(), 'models'));
const tier = process.env.OPENKT_MODEL_TIER === '4b' ? '4b' : '2b';
const reportPath = resolve(process.env.OPENKT_SMOKE_REPORT || 'smoke-local-ai-report.json');
const extraArgs = (process.env.OPENKT_LLAMA_EXTRA_ARGS || '').split(' ').filter(Boolean);

const report = {
  ok: false,
  host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, totalMemGiB: +(totalmem() / 1024 ** 3).toFixed(1), tierForThisHost: chooseTier(totalmem()) },
  tierUsed: tier,
  llama: {},
  checks: {},
  latenciesMs: {},
};
const checks = report.checks;
function check(name, pass, detail) {
  checks[name] = { pass: Boolean(pass), ...detail };
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail ?? {})}`);
  if (!pass) throw new Error(`check failed: ${name}`);
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const pgrep = () => { try { return execFileSync('pgrep', ['-f', join(llamaDir, 'llama-server')]).toString().trim().split('\n').filter(Boolean); } catch { return []; } };

const manifest = loadManifest();
const plan = chooseModels(manifest, totalmem(), tier);
const ai = new LlamaLocalAi({ llamaDir, modelsDir, plan, extraArgs, log: (l) => console.log(l) });
process.on('exit', () => ai.killNow());

try {
  let version;
  try { version = execFileSync('sh', ['-c', `"${join(llamaDir, 'llama-server')}" --version 2>&1`], { cwd: llamaDir, encoding: 'utf8' }).trim(); } catch (e) { version = `--version failed: ${e.message}`; }
  report.llama = { dir: llamaDir, tag: manifest.llama.tag, version };

  // (a) interrupted download resumes. Uses the embedding model; when it is already cached,
  // the interruption runs against a scratch copy so the cache stays warm.
  {
    const m = plan.embed;
    const cached = join(modelsDir, localName(m));
    const dest = existsSync(cached) && statSync(cached).size === m.bytes ? join(modelsDir, `resume-test-${localName(m)}`) : cached;
    rmSync(dest, { force: true }); rmSync(`${dest}.part`, { force: true });
    const ac = new AbortController();
    const t0 = performance.now();
    let events = 0; let first = 0; let last = 0;
    let aborted = false;
    try {
      await downloadFile({ url: modelUrl(m), dest, bytes: m.bytes, sha256: m.sha256, signal: ac.signal,
        onProgress: (p) => { events += 1; first ||= performance.now(); last = performance.now(); if (p.receivedBytes > m.bytes * 0.3) ac.abort(); } });
    } catch { aborted = true; }
    const partial = existsSync(`${dest}.part`) ? statSync(`${dest}.part`).size : -1;
    const maxRate = events > 1 ? events / Math.max(0.001, (last - first) / 1000) : 0;
    const second = await downloadFile({ url: modelUrl(m), dest, bytes: m.bytes, sha256: m.sha256 });
    const digest = await sha256File(dest);
    report.latenciesMs.embedModelDownload = Math.round(performance.now() - t0);
    check('a_download_resume', aborted && partial > 0 && partial < m.bytes && !existsSync(dest + '.part') && second.resumedFrom === partial && statSync(dest).size === m.bytes && digest === m.sha256,
      { abortedAtBytes: partial, resumedFrom: second.resumedFrom, finalBytes: statSync(dest).size, sha256: digest, expectedSha256: m.sha256, progressEventsPerSec: +maxRate.toFixed(2) });
    if (dest !== cached) rmSync(dest, { force: true });
  }

  // Models through the same store the app uses (embeddings first, then the LLM; no mmproj in CI).
  {
    const t0 = performance.now();
    const order = [];
    const status = await ai.ensureModels((p) => { if (!order.includes(p.role)) order.push(p.role); }, ['embed', 'llm']);
    report.latenciesMs.ensureModels = Math.round(performance.now() - t0);
    check('models_ready', status.every((s) => s.state === 'ready') && order[0] === 'embed', { order, files: status.map((s) => `${s.file}:${s.receivedBytes}`) });
  }

  // (b) embeddings
  {
    const t0 = performance.now();
    await ai.embedServer.ensureStarted();
    report.latenciesMs.embedServerStart = Math.round(performance.now() - t0);
    const docs = [
      'The customer wants per-store pricing instead of a flat fee for the whole chain.',
      'They asked to be charged for each shop separately rather than one price for all locations.',
      'The hiking trail was closed after heavy snowfall in the mountains.',
      'My sourdough starter needs feeding twice a day in summer.',
    ];
    const t1 = performance.now();
    const v = await ai.embed(docs, 'document');
    report.latenciesMs.embed4Docs = Math.round(performance.now() - t1);
    const t2 = performance.now();
    const [q] = await ai.embed(['How does the customer want to be charged?'], 'query');
    report.latenciesMs.embed1Query = Math.round(performance.now() - t2);
    const norms = v.map((x) => Math.sqrt(x.reduce((s, y) => s + y * y, 0)));
    const para = cosine(v[0], v[1]); const unrelated = cosine(v[2], v[3]);
    const qRel = cosine(q, v[0]); const qUnrel = cosine(q, v[3]);
    check('b_embeddings', v.every((x) => x.length === EMBED_DIM) && q.length === EMBED_DIM && norms.every((n) => Math.abs(n - 1) < 1e-3) && para > unrelated && qRel > qUnrel,
      { dim: v[0].length, norms: norms.map((n) => +n.toFixed(5)), cosParaphrase: +para.toFixed(4), cosUnrelated: +unrelated.toFixed(4), cosQueryRelevant: +qRel.toFixed(4), cosQueryIrrelevant: +qUnrel.toFixed(4) });
  }

  // (c) extract + (d) summarise, through @openkt/agents against the local chat server
  {
    const agents = await loadAgents();
    const fixture = JSON.parse(readFileSync(join(root, '../../packages/agents/fixtures/extract/sales-call-per-store-pricing.json'), 'utf8'));
    const t0 = performance.now();
    const base = await ai.chatBaseUrl();
    report.latenciesMs.chatServerStart = Math.round(performance.now() - t0);
    const client = new agents.OpenAiCompatibleClient({ baseUrl: base, model: 'local', timeoutMs: 300_000 });

    const x = await agents.extract.run(fixture.input, client);
    report.latenciesMs.extract = Math.round(x.latency_ms);
    const chunkText = typeof fixture.input.chunk === 'string' ? fixture.input.chunk : fixture.input.chunk.map((t) => t.text).join('\n');
    const gate = agents.quoteGate(x.output.facts, chunkText);
    check('c_extract', x.status === 'ok' && x.output.facts.length >= 1 && gate.kept.length >= 1,
      { status: x.status, attempts: x.attempts, facts: x.output.facts.length, quoteGateKept: gate.kept.length, dropped: x.dropped, usage: x.usage, errors: x.errors, sample: x.output.facts.slice(0, 3) });

    const s = await agents.summarise.run(fixture.input, client);
    report.latenciesMs.summarise = Math.round(s.latency_ms);
    const words = s.output.title.trim().split(/\s+/).filter(Boolean).length;
    check('d_summarise', s.status === 'ok' && words >= 1 && words <= 8, { status: s.status, attempts: s.attempts, title: s.output.title, titleWords: words, summary: s.output.summary, usage: s.usage, errors: s.errors });

    // The exact path the app's IPC handler takes.
    const t1 = performance.now();
    const note = await extractNote(ai, { text: chunkText, title: fixture.input.session.title, source: 'meeting' }, 300_000);
    report.latenciesMs.extractNoteIpcPath = Math.round(performance.now() - t1);
    check('extract_note_ipc_path', note.status !== 'noop' && typeof note.title === 'string', { status: note.status, title: note.title, facts: note.facts.length });

    // The LocalAi.chat() seam itself.
    const c = await ai.chat({ messages: [{ role: 'user', content: 'Reply with the capital of France.' }], schema: { name: 'answer', schema: { type: 'object', properties: { capital: { type: 'string' } }, required: ['capital'], additionalProperties: false } }, maxTokens: 50 });
    report.latenciesMs.chatTiny = c.latencyMs;
    check('chat_json_schema', typeof JSON.parse(c.text).capital === 'string', { text: c.text });
  }

  // (e) no orphans
  {
    const pids = [ai.chatServer.pid, ai.embedServer.pid];
    const before = pgrep();
    const t0 = performance.now();
    await ai.stop();
    report.latenciesMs.stop = Math.round(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 500));
    const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const after = pgrep();
    check('e_no_orphans', pids.every(Boolean) && before.length >= 2 && alive.length === 0 && after.length === 0, { pids, runningBefore: before.length, alive, runningAfter: after.length });
  }
  report.ok = true;
} catch (e) {
  report.error = e?.message ?? String(e);
  report.logTail = { chat: ai.chatServer.logTail, embed: ai.embedServer.logTail };
  console.error(report.error);
} finally {
  ai.killNow();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nlatencies (ms): ${JSON.stringify(report.latenciesMs)}\nreport → ${reportPath}`);
  process.exit(report.ok ? 0 : 1);
}
