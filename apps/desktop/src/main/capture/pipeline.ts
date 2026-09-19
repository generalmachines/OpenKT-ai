/**
 * Wires the capture services to the local AI runtime. No `electron` import: the app (ipc.ts)
 * and the CI proof (scripts/smoke-capture.mjs) build the services through these two functions.
 */
import { join } from 'node:path';
import { extractNote, loadAgents } from '../local-ai/agents';
import type { LlamaLocalAi } from '../local-ai/local-ai';
import { ScreenshotService, type ScreenshotDeps } from './screenshot';
import { VoiceService, type VoiceDeps } from './voice';
import { Whisper } from './whisper';

export interface CapturePaths {
  /** Directory holding `whisper-cli` (Contents/Resources/whisper when packaged). */
  whisperDir: string;
  /** Directory holding `openkt-ocr` (Contents/Resources/ocr when packaged). */
  ocrDir: string;
  tmpDir: string;
}

export const whisperBinary = (dir: string) => join(dir, 'whisper-cli');
export const ocrBinary = (dir: string) => join(dir, 'openkt-ocr');

export function createVoiceService(ai: LlamaLocalAi, paths: CapturePaths, extra: Pick<VoiceDeps, 'askMicrophone'> & { log?: (l: string) => void; agentTimeoutMs?: number; whisperCpuOnly?: boolean } = {}): VoiceService {
  const whisper = new Whisper({ binary: whisperBinary(paths.whisperDir), model: ai.store.pathOf('whisper'), cpuOnly: extra.whisperCpuOnly, log: extra.log });
  return new VoiceService({
    whisper,
    tmpDir: join(paths.tmpDir, 'voice'),
    askMicrophone: extra.askMicrophone,
    modelReady: async () => (await ai.store.status(['whisper']))[0]?.state === 'ready',
    toNote: async (text) => {
      const note = await extractNote(ai, { text, source: 'voice' }, extra.agentTimeoutMs);
      return { title: note.title, summary: note.summary, facts: note.facts, status: note.status };
    },
  });
}

export function createScreenshotService(
  ai: LlamaLocalAi,
  paths: CapturePaths,
  extra: Pick<ScreenshotDeps, 'screenAccess' | 'beforeInteractive' | 'afterInteractive'> & { agentTimeoutMs?: number } = {},
): ScreenshotService {
  const timeoutMs = extra.agentTimeoutMs ?? 180_000;
  const crashed = async () => (await new Promise((r) => setTimeout(r, 400)), ai.fallBackToCpuIfCrashed());
  /** Same GPU → CPU safety net as LocalAi.chat(): a crash is a thrown transport error or a no-op. */
  async function withCpuFallback<T extends { status: 'ok' | 'noop' }>(fn: () => Promise<T>): Promise<T> {
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      if (await crashed()) return fn();
      throw e;
    }
    return out.status === 'noop' && (await crashed()) ? fn() : out;
  }
  return new ScreenshotService({
    tmpDir: join(paths.tmpDir, 'screenshots'),
    ocrBinary: ocrBinary(paths.ocrDir),
    screenAccess: extra.screenAccess,
    beforeInteractive: extra.beforeInteractive,
    afterInteractive: extra.afterInteractive,
    describe: async (input) => {
      if (!ai.visionAvailable()) return null;
      const agents = await loadAgents();
      const r = await withCpuFallback(async () => {
        const baseUrl = await ai.visionBaseUrl();
        if (!baseUrl) throw new Error('the vision projector is not on disk');
        const client = new agents.OpenAiCompatibleClient({ baseUrl, model: 'local', timeoutMs });
        const run = await agents.describeImage.run({ image: { base64: input.base64, mime_type: input.mime_type }, caption: input.caption, ocr_text: input.ocr_text }, client);
        ai.chatServer.touch();
        return run;
      });
      return { ...r.output, status: r.status };
    },
    extract: async (turns, source) => {
      const agents = await loadAgents();
      const r = await withCpuFallback(async () => {
        const client = new agents.OpenAiCompatibleClient({ baseUrl: await ai.chatBaseUrl(), model: 'local', timeoutMs });
        const run = await agents.extract.run({ chunk: turns, session: { date: new Date().toISOString().slice(0, 10), title: '', source, author: '' } }, client);
        ai.chatServer.touch();
        return run;
      });
      return { facts: r.output.facts.map((f) => ({ kind: f.kind ?? 'fact', statement: f.statement, quote: f.quote })), status: r.status };
    },
  });
}
