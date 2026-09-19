import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlamaServer } from '../../src/main/local-ai/supervisor';
import { QUERY_PREFIX, l2normalise } from '../../src/main/local-ai/local-ai';

const FAKE = join(__dirname, 'fixtures', 'fake-llama-server.mjs');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return fn(); };

let servers: LlamaServer[] = [];
const make = (mode: string, extra: Partial<ConstructorParameters<typeof LlamaServer>[0]> = {}) => {
  const log = join(mkdtempSync(join(tmpdir(), 'okt-sup-')), 'spawns.log');
  const s = new LlamaServer({ name: mode, binary: process.execPath, args: [FAKE], env: { FAKE_MODE: mode, FAKE_LOG: log }, healthIntervalMs: 20, ...extra });
  servers.push(s);
  return { s, spawns: () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } } };
};
afterEach(async () => { await Promise.all(servers.map((s) => s.stop())); servers = []; });

describe('LlamaServer supervisor', () => {
  it('starts on a free port bound to 127.0.0.1, reports ready, and stop() leaves no process', async () => {
    const { s, spawns } = make('ok');
    const url = await s.ensureStarted();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(s.state).toBe('ready');
    expect(spawns()[0]).toContain(` 127.0.0.1 ${s.port}`);
    expect((await fetch(`${url}/health`)).ok).toBe(true);
    const pid = s.pid as number;
    expect(await s.ensureStarted()).toBe(url); // idempotent: no second spawn
    expect(spawns().length).toBe(1);
    await s.stop();
    expect(alive(pid)).toBe(false);
    expect(s.state).toBe('stopped');
  });

  it('restarts a crashed server at most 3 times, then stays failed', async () => {
    const { s, spawns } = make('crash-after-ready');
    await s.ensureStarted();
    expect(await until(() => s.state === 'failed', 15_000)).toBe(true);
    expect(s.restarts).toBe(3);
    expect(spawns().length).toBe(4); // 1 start + 3 restarts
    expect(s.lastError).toContain('code=9');
  });

  it('a binary that exits immediately fails with its output in the error', async () => {
    const { s, spawns } = make('exit-immediately');
    await expect(s.ensureStarted()).rejects.toThrow(/failed to start[\s\S]*cannot load model/);
    expect(s.state).toBe('failed');
    expect(spawns().length).toBe(4);
  }, 30_000);

  it('times out when /health never turns ok, and kills the child', async () => {
    const { s } = make('never-healthy', { startTimeoutMs: 300, maxRestarts: 0 });
    await expect(s.ensureStarted()).rejects.toThrow(/no healthy \/health/);
    expect(s.pid === null || !alive(s.pid)).toBe(true);
  });

  it('unloads after the idle window and starts again on demand', async () => {
    const { s, spawns } = make('ok', { idleMs: 150 });
    await s.ensureStarted();
    const pid = s.pid as number;
    expect(await until(() => s.state === 'stopped' && !alive(pid))).toBe(true);
    await s.ensureStarted();
    expect(s.state).toBe('ready');
    expect(spawns().length).toBe(2);
  });

  it('touch() keeps a busy server loaded', async () => {
    const { s } = make('ok', { idleMs: 200 });
    await s.ensureStarted();
    for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 80)); s.touch(); }
    expect(s.state).toBe('ready');
  });

  it('killNow() is synchronous and final', async () => {
    const { s } = make('ok');
    await s.ensureStarted();
    const pid = s.pid as number;
    s.killNow();
    expect(await until(() => !alive(pid))).toBe(true);
  });
});

describe('embedding helpers', () => {
  it('normalises to unit length and carries the retrieval instruction', () => {
    const v = l2normalise([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    expect(QUERY_PREFIX).toBe('Instruct: Given a question, retrieve team context that answers it\nQuery: ');
  });
});
