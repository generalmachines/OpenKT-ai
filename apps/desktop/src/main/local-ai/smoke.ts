/**
 * OPENKT_SMOKE=1: prove the PACKAGED app can find and run its bundled binaries
 * after packaging and ad-hoc signing. Opens the window, reads models.status, starts
 * the embedding server on a model that CI already cached, embeds two strings, runs the
 * bundled `whisper-cli --help` and `openkt-ocr` on OPENKT_SMOKE_OCR_IMAGE, writes a
 * JSON result and quits 0/1. Never runs for users.
 */
import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMBED_DIM } from './local-ai';
import { capturePaths } from '../capture/ipc';
import { ocrBinary, whisperBinary } from '../capture/pipeline';
import { parseOcrOutput } from '../capture/screenshot';
import { getLocalAi } from './ipc';

export const isSmoke = (): boolean => process.env['OPENKT_SMOKE'] === '1';

export async function runSmoke(openWindow: () => Promise<unknown>): Promise<void> {
  const out = process.env['OPENKT_SMOKE_OUT'] || join(tmpdir(), 'openkt-smoke-result.json');
  const result: Record<string, unknown> = { ok: false, packaged: app.isPackaged, resourcesPath: process.resourcesPath, steps: [] as string[] };
  const step = (s: string) => (result['steps'] as string[]).push(s);
  const ai = getLocalAi();
  const timer = setTimeout(() => {
    result['error'] = 'smoke timed out after 240 s';
    writeFileSync(out, JSON.stringify(result, null, 2));
    ai.killNow();
    app.exit(1);
  }, 240_000);
  try {
    await openWindow();
    step('window');
    const status = await ai.status();
    result['status'] = status;
    step('models.status');
    if (!status.binaryFound) throw new Error(`llama-server not found at ${status.binary}`);
    const embed = status.models.find((m) => m.role === 'embed');
    if (embed?.state !== 'ready') throw new Error(`embedding model not cached at ${embed?.path} (state ${embed?.state})`);
    const t0 = performance.now();
    const vectors = await ai.embed(['per-store pricing', 'hosting in Singapore'], 'document');
    result['embedStartAndFirstCallMs'] = Math.round(performance.now() - t0);
    result['dim'] = vectors[0]?.length;
    result['cpuFallback'] = ai.cpuFallback;
    step('embed');
    if (vectors.length !== 2 || vectors[0]?.length !== EMBED_DIM) throw new Error(`unexpected embedding shape ${vectors.length}x${vectors[0]?.length}`);
    await ai.stop();
    step('stop');

    const paths = capturePaths();
    const help = spawnSync(whisperBinary(paths.whisperDir), ['--help'], { encoding: 'utf8', timeout: 30_000 });
    const helpText = `${help.stdout ?? ''}${help.stderr ?? ''}`;
    result['whisper'] = { binary: whisperBinary(paths.whisperDir), exitCode: help.status, signal: help.signal, error: help.error?.message, mentionsOutputJson: helpText.includes('--output-json'), mentionsNoGpu: helpText.includes('--no-gpu') };
    if (help.status !== 0 || !helpText.includes('--output-json')) throw new Error(`bundled whisper-cli --help failed: status ${help.status} ${help.error?.message ?? ''}`);
    step('whisper-cli --help');

    const image = process.env['OPENKT_SMOKE_OCR_IMAGE'];
    if (image) {
      const t1 = performance.now();
      const run = spawnSync(ocrBinary(paths.ocrDir), [image], { encoding: 'utf8', timeout: 60_000 });
      const ocr = run.status === 0 ? parseOcrOutput(run.stdout) : null;
      result['ocr'] = { binary: ocrBinary(paths.ocrDir), exitCode: run.status, signal: run.signal, error: run.error?.message, ms: Math.round(performance.now() - t1), lines: ocr?.lines.length, text: ocr?.text.slice(0, 1500), stderr: run.stderr?.slice(0, 500) };
      if (!ocr) throw new Error(`bundled openkt-ocr failed: status ${run.status} ${run.error?.message ?? run.stderr ?? ''}`);
      for (const needle of ['Per-store billing', '$49']) if (!ocr.text.includes(needle)) throw new Error(`openkt-ocr did not read "${needle}"`);
      step('openkt-ocr');
    }
    result['ok'] = true;
  } catch (e) {
    result['error'] = (e as Error).message;
    result['logTail'] = ai.embedServer.logTail;
  }
  clearTimeout(timer);
  writeFileSync(out, JSON.stringify(result, null, 2));
  ai.killNow();
  app.exit(result['ok'] === true ? 0 : 1);
}
