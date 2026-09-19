/**
 * OPENKT_SMOKE=1: prove the PACKAGED app can find and run its bundled llama
 * binaries. Opens the window, reads models.status, starts the embedding server
 * on a model that CI already cached, embeds two strings, writes a JSON result
 * and quits 0/1. Never runs for users.
 */
import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMBED_DIM } from './local-ai';
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
