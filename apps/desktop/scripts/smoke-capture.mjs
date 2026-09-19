#!/usr/bin/env node
/**
 * The capture proof, run on macOS in CI: the SAME main-process modules the app uses for voice
 * notes and screenshots (src/main/capture), outside Electron — like smoke-local-ai.mjs.
 *   OPENKT_LLAMA_DIR / OPENKT_WHISPER_DIR / OPENKT_OCR_DIR   binaries (default resources/<name>)
 *   OPENKT_MODELS_DIR     model cache (default ~/models)
 *   OPENKT_MODEL_TIER     2b | 4b (default 2b);  OPENKT_WHISPER_MODEL  base | small | turbo (default base)
 *   OPENKT_VOICE_WAV      16 kHz mono PCM16 WAV of the spoken sentence (CI: `say` + `afconvert`)
 *   OPENKT_VOICE_NEEDLES comma-separated words the transcript must contain (default northgate,per store,friday)
 *   OPENKT_SHOT_PNG       the screenshot fixture (default test/fixtures/pricing-page.png)
 *   OPENKT_SMOKE_VISION   required | try (default) | skip — with "try", a vision failure is REPORTED
 *                         (visionExecuted: false) and OCR + extract must still pass
 *   OPENKT_SMOKE_REPORT   report path (default ./smoke-capture-report.json)
 * Requires `npm run build:main` first.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, totalmem, cpus, platform, arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const main = (p) => require(join(root, 'dist-electron/main', p));
const { loadManifest, chooseModels, whisperFromEnv } = main('models/manifest.js');
const { LlamaLocalAi } = main('local-ai/local-ai.js');
const { loadAgents } = main('local-ai/agents.js');
const { createVoiceService, createScreenshotService, whisperBinary, ocrBinary } = main('capture/pipeline.js');
const { pcmFromWav } = main('capture/wav.js');
const { numbersIn } = main('capture/screenshot.js');

const dir = (env, name) => resolve(process.env[env] || join(root, 'resources', name));
const paths = { whisperDir: dir('OPENKT_WHISPER_DIR', 'whisper'), ocrDir: dir('OPENKT_OCR_DIR', 'ocr'), tmpDir: mkdtempSync(join(tmpdir(), 'openkt-capture-')) };
const llamaDir = dir('OPENKT_LLAMA_DIR', 'llama');
const modelsDir = resolve(process.env.OPENKT_MODELS_DIR || join(homedir(), 'models'));
const tier = process.env.OPENKT_MODEL_TIER === '4b' ? '4b' : '2b';
const whisperSize = whisperFromEnv(process.env.OPENKT_WHISPER_MODEL) ?? 'base';
const visionMode = ['required', 'skip'].includes(process.env.OPENKT_SMOKE_VISION) ? process.env.OPENKT_SMOKE_VISION : 'try';
const voiceWav = process.env.OPENKT_VOICE_WAV;
const shotPng = resolve(process.env.OPENKT_SHOT_PNG || join(root, 'test/fixtures/pricing-page.png'));
const reportPath = resolve(process.env.OPENKT_SMOKE_REPORT || 'smoke-capture-report.json');
const extraArgs = (process.env.OPENKT_LLAMA_EXTRA_ARGS || '').split(' ').filter(Boolean);
const AGENT_TIMEOUT_MS = 600_000;

const report = {
  ok: false,
  host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, totalMemGiB: +(totalmem() / 1024 ** 3).toFixed(1) },
  models: { tier, whisper: whisperSize },
  binaries: { whisper: whisperBinary(paths.whisperDir), ocr: ocrBinary(paths.ocrDir), llamaDir },
  visionMode,
  visionExecuted: false,
  checks: {},
  latenciesMs: {},
};
function check(name, pass, detail) {
  report.checks[name] = { pass: Boolean(pass), ...detail };
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail ?? {})}`);
  if (!pass) throw new Error(`check failed: ${name}`);
}
/** "per-store" and "per store" are the same words: compare on letters and digits only. */
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, ' ').trim();
const KINDS = ['decision', 'fact', 'how-to', 'question', 'action', 'idea', 'issue'];
const validFact = (f) => f && KINDS.includes(f.kind) && typeof f.statement === 'string' && f.statement.trim().length > 0 && typeof f.quote === 'string' && f.quote.trim().length >= 8;

const plan = chooseModels(loadManifest(), totalmem(), tier, whisperSize);
const ai = new LlamaLocalAi({ llamaDir, modelsDir, plan, extraArgs, log: (l) => console.log(l) });
process.on('exit', () => ai.killNow());

try {
  {
    const t0 = performance.now();
    const roles = ['llm', 'whisper', ...(visionMode === 'skip' ? [] : ['mmproj'])];
    const status = await ai.ensureModels(undefined, roles);
    report.latenciesMs.ensureModels = Math.round(performance.now() - t0);
    check('models_ready', status.every((s) => s.state === 'ready'), { files: status.map((s) => `${s.role}:${s.file}:${s.receivedBytes}`) });
  }
  const agents = await loadAgents();
  const voice = createVoiceService(ai, paths, { log: (l) => console.log(l), agentTimeoutMs: AGENT_TIMEOUT_MS });
  const shots = createScreenshotService(ai, paths, { agentTimeoutMs: AGENT_TIMEOUT_MS });
  const wavsLeft = () => (existsSync(join(paths.tmpDir, 'voice')) ? readdirSync(join(paths.tmpDir, 'voice')) : []);

  // 1. Voice: begin → chunk (250 ms pieces, as the renderer sends them) → end → toSession
  if (!voiceWav) throw new Error('OPENKT_VOICE_WAV is not set');
  const { pcm, sampleRate, channels } = pcmFromWav(readFileSync(voiceWav));
  check('voice_fixture_is_16k_mono_pcm16', sampleRate === 16000 && channels === 1, { sampleRate, channels, bytes: pcm.length });
  const clipMs = Math.round((pcm.length / 2 / 16000) * 1000);
  const push = (buf) => pushTo(voice, buf);
  const pushTo = async (voice, buf) => {
    const id = await voice.begin();
    if (typeof id !== 'string') throw new Error(`voice.begin: ${JSON.stringify(id)}`);
    for (let off = 0; off < buf.length; off += 8000) {
      const piece = buf.subarray(off, Math.min(buf.length, off + 8000));
      // An ArrayBuffer, which is what crosses the IPC boundary in the app.
      voice.chunk(id, piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength));
    }
    return id;
  };
  {
    const id = await push(pcm);
    const r = await voice.end(id, { language: 'auto' });
    if (r.error) throw new Error(`voice.end: ${r.error}: ${r.message}`);
    report.latenciesMs.transcribe = r.transcribe_ms;
    report.transcript = { text: r.text, raw_text: r.raw_text, language: r.language, duration_ms: r.duration_ms, clip_ms: clipMs, used_gpu: r.used_gpu, segments: r.segments };
    const heard = words(r.text ?? '');
    const needles = (process.env.OPENKT_VOICE_NEEDLES || 'northgate,per store,friday').split(',').map(words).filter(Boolean);
    check('voice_transcript', !r.empty && needles.every((n) => heard.includes(n)), { text: r.text, language: r.language, needles, missing: needles.filter((n) => !heard.includes(n)), transcribeMs: r.transcribe_ms, usedGpu: r.used_gpu });
    check('voice_duration', Math.abs(r.duration_ms - clipMs) <= 50 && r.segments.length >= 1 && r.segments.at(-1).t1_ms <= clipMs + 1500, { duration_ms: r.duration_ms, clip_ms: clipMs, lastSegmentEndMs: r.segments.at(-1)?.t1_ms });
    check('voice_wav_deleted', wavsLeft().length === 0, { left: wavsLeft() });

    const t0 = performance.now();
    const s = await voice.toSession(id);
    report.latenciesMs.voiceToSession = Math.round(performance.now() - t0);
    if (s.error) throw new Error(`voice.toSession: ${s.error}: ${s.message}`);
    const gate = agents.quoteGate(s.facts, r.text);
    report.voiceSession = s;
    check('voice_to_session', s.facts.length >= 1 && s.facts.every(validFact) && gate.dropped.length === 0 && typeof s.title === 'string', { status: s.status, title: s.title, summary: s.summary, facts: s.facts, quoteGateDropped: gate.dropped.length });
    check('voice_session_forgotten', voice.activeCount === 0, { activeCount: voice.activeCount });

    // The same clip on the CPU (`-ng`), the path a Mac takes after a Metal failure. On CI this is also the
    // honest latency: the runner's GPU is a paravirtual device and far slower than its CPU.
    const onCpu = createVoiceService(ai, paths, { whisperCpuOnly: true });
    const c = await onCpu.end(await pushTo(onCpu, pcm), { language: 'auto' });
    if (c.error) throw new Error(`voice.end on the CPU: ${c.error}: ${c.message}`);
    report.latenciesMs.transcribeCpu = c.transcribe_ms;
    const heardCpu = words(c.text ?? '');
    check('voice_transcript_cpu', !c.empty && c.used_gpu === false && needles.every((n) => heardCpu.includes(n)) && wavsLeft().length === 0, { text: c.text, transcribeMs: c.transcribe_ms, usedGpu: c.used_gpu });
  }
  {
    const short = await voice.end(await push(pcm.subarray(0, 32000)));
    const silent = await voice.end(await push(Buffer.alloc(16000 * 2 * 3)));
    check('voice_short_clip_is_empty', short.empty === true && short.reason === 'too_short' && silent.empty === true && silent.reason === 'silence' && wavsLeft().length === 0 && voice.activeCount === 0, { oneSecond: short, threeSecondsOfSilence: silent });
  }

  // 2. OCR alone
  let ocrText = '';
  {
    const t0 = performance.now();
    const ocr = await shots.ocr(shotPng);
    report.latenciesMs.ocr = Math.round(performance.now() - t0);
    ocrText = ocr.text;
    report.ocr = { lines: ocr.lines.length, text: ocr.text, firstLine: ocr.lines[0] };
    const boxesOk = ocr.lines.every((l) => [l.x, l.y, l.w, l.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1) && l.confidence > 0);
    check('ocr_reads_the_pricing_page', ocr.text.includes('Per-store billing') && ocr.text.includes('$49') && boxesOk, { lines: ocr.lines.length, chars: ocr.text.length, ms: report.latenciesMs.ocr, boxesOk });
  }

  // 3. The whole screenshot pipeline in `file` mode
  {
    const t0 = performance.now();
    const r = await shots.capture({ mode: 'file', path: shotPng });
    report.latenciesMs.screenshotPipeline = Math.round(performance.now() - t0);
    if (r.error) throw new Error(`screenshot.capture: ${r.error}: ${r.message}`);
    report.screenshot = r;
    report.latenciesMs.describe = r.latency_ms.describe;
    report.latenciesMs.screenshotExtract = r.latency_ms.extract;
    report.latenciesMs.resize = r.latency_ms.resize;
    report.cpuFallback = ai.cpuFallback;
    report.chatServerArgs = ai.chatServer.lastArgs;
    report.visionExecuted = r.vision === 'ok';
    const seen = new Set(numbersIn(ocrText));
    const strayNumbers = r.facts.flatMap((f) => [...numbersIn(f.statement), ...numbersIn(f.quote)]).filter((n) => !seen.has(n));
    if (r.vision === 'ok') {
      check('vision_describes_the_page', /pric|plan|tier/i.test(r.description) && r.description.split(/\s+/).length <= 61, { description: r.description, entities: r.entities, describeMs: r.latency_ms.describe, mmproj: ai.chatServer.lastArgs.includes('--mmproj'), cpuFallback: ai.cpuFallback });
    } else {
      report.visionNotExecuted = `describe_image did NOT run on this machine (vision: ${r.vision}); only OCR + extract are proven here. ${r.notes.join(' | ')}`;
      console.log(`WARN  ${report.visionNotExecuted}`);
      if (visionMode === 'required') throw new Error(report.visionNotExecuted);
    }
    check('screenshot_facts', !r.nothing_to_save && r.facts.length >= 1 && r.facts.every(validFact) && strayNumbers.length === 0 && r.title.length > 0 && r.image_path === shotPng,
      { vision: r.vision, title: r.title, facts: r.facts, droppedByNumberRule: r.dropped_facts, strayNumbers, extractMs: r.latency_ms.extract, visible_text_chars: r.visible_text.length });
  }

  await ai.stop();
  report.ok = true;
} catch (e) {
  report.error = e?.message ?? String(e);
  report.logTail = { chat: ai.chatServer.logTail };
  console.error(report.error);
} finally {
  ai.killNow();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nlatencies (ms): ${JSON.stringify(report.latenciesMs)}\nvision executed: ${report.visionExecuted}\nreport → ${reportPath}`);
  process.exit(report.ok ? 0 : 1);
}
