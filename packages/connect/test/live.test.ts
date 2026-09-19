import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTool } from '../src/api.js';
import { writeCredentials } from '../src/credentials.js';
import { homeEnv } from '../src/env.js';
import { hookScriptPath } from '../src/integrations/common.js';
import { call, type FetchLike } from '../src/server.js';

/**
 * Live: the installed hook script against a real server with an existing throwaway account (never signs up: sign-ups
 * are rate limited per address). Skipped unless OPENKT_LIVE_EMAIL and OPENKT_LIVE_PASSWORD are set.
 *   OPENKT_LIVE_SERVER=https://api.openkt.ai OPENKT_LIVE_EMAIL=… OPENKT_LIVE_PASSWORD=… npx vitest run test/live.test.ts
 */
const SERVER = (process.env['OPENKT_LIVE_SERVER'] ?? 'https://api.openkt.ai').replace(/\/+$/, '');
const EMAIL = process.env['OPENKT_LIVE_EMAIL'];
const PASSWORD = process.env['OPENKT_LIVE_PASSWORD'];
const f = fetch as unknown as FetchLike;

let home: string;
let token = '';
const nonce = `kiwi-${Date.now().toString(36)}`;

function hook(args: string[], input: unknown): Promise<{ stdout: string; ms: number }> {
  const started = Date.now();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENKT_')) env[k] = v;
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [hookScriptPath(homeEnv(home)), ...args], { env: { ...env, HOME: home, OPENKT_NO_KEYCHAIN: '1', CLAUDE_PROJECT_DIR: home }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', () => resolve({ stdout: out, ms: Date.now() - started }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const ctxOf = (stdout: string) => (stdout ? (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!EMAIL || !PASSWORD)(`live against ${SERVER}`, () => {
  const created: string[] = [];

  beforeAll(async () => {
    const login = await call<{ token: string }>(f, SERVER, 'POST', '/v1/auth/login', { body: { email: EMAIL, password: PASSWORD, client: 'cli' } });
    expect(login.status, JSON.stringify(login.error)).toBe(200);
    token = login.data!.token;
    home = mkdtempSync(join(tmpdir(), 'okt-live-'));
    const env = homeEnv(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    await writeCredentials(env, { server: SERVER, token }, null);
    await connectTool(env, 'claude-code');
  }, 30_000);

  afterAll(async () => {
    for (const id of created) await call(f, SERVER, 'DELETE', `/v1/memories/${id}`, { token });
    await call(f, SERVER, 'POST', '/v1/auth/logout', { token });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('start → prompt → reply → end lands on the server as a session with its turns', async () => {
    const sid = `live-${nonce}-1`;
    const start = await hook(['claude-code', 'session-start'], { session_id: sid, cwd: home, source: 'startup' });
    expect(start.ms).toBeLessThan(2000);
    const session = /OpenKT session ([0-9a-f-]{36})/.exec(ctxOf(start.stdout))?.[1];
    expect(session, start.stdout).toBeTruthy();
    const p = await hook(['claude-code', 'prompt'], { session_id: sid, cwd: home, prompt: `Remember for the team: the ${nonce} service deploys only from the release branch.` });
    expect(p.ms).toBeLessThan(2000);
    await hook(['claude-code', 'stop'], { session_id: sid, cwd: home, last_assistant_message: `Noted: ${nonce} deploys from release.` });
    // A Claude Code memory file, synced as a fact (native memory), is the durable part a later session recalls.
    const memDir = join(home, '.claude', 'projects', '-live', 'memory');
    mkdirSync(memDir, { recursive: true });
    const memFile = join(memDir, `${nonce}.md`);
    writeFileSync(memFile, `---\nname: ${nonce} deploys\ntype: project\n---\nThe ${nonce} service deploys only from the release branch, never from main.\n`);
    await hook(['claude-code', 'native-memory'], { session_id: sid, cwd: home, tool_name: 'Write', tool_input: { file_path: memFile } });
    await hook(['claude-code', 'session-end'], { session_id: sid, cwd: home, reason: 'prompt_input_exit' });

    type Detail = { status?: string; session?: { status?: string }; turns?: { role: string; content: string }[] };
    let detail: Detail | null = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await call<Detail>(f, SERVER, 'GET', `/v1/sessions/${session}`, { token });
      detail = res.data;
      if ((detail?.session?.status ?? detail?.status) === 'closed' && (detail?.turns?.length ?? 0) >= 2) break;
    }
    expect(detail?.session?.status ?? detail?.status).toBe('closed');
    expect(detail?.turns?.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(detail?.turns?.[0]?.content).toContain(nonce);

    const mine = await call<{ id: string; content: string }[]>(f, SERVER, 'POST', '/v1/memories/recall', { token, body: { query: `${nonce} deploys`, limit: 5 } });
    const fact = (mine.data ?? []).find((m) => m.content.includes(nonce));
    expect(fact, JSON.stringify(mine.data?.map((m) => m.content))).toBeTruthy();
    created.push(fact!.id);
  }, 60_000);

  it('a prompt in a second session recalls the fact saved in the first', async () => {
    const sid = `live-${nonce}-2`;
    await hook(['claude-code', 'session-start'], { session_id: sid, cwd: home, source: 'startup' });
    let context = '';
    for (let i = 0; i < 6 && !context.includes(nonce); i++) {
      const r = await hook(['claude-code', 'prompt'], { session_id: sid, cwd: home, prompt: `Which branch does the ${nonce} service deploy from?` });
      expect(r.ms).toBeLessThan(2000);
      context = ctxOf(r.stdout);
      if (!context.includes(nonce)) await sleep(2000);
    }
    expect(context).toContain(nonce);
    expect(context).toMatch(/— \S/);
    await hook(['claude-code', 'session-end'], { session_id: sid, cwd: home });
  }, 60_000);

  it('the stdio MCP bridge reaches the real server with the stored credentials', async () => {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ];
    const r = await hook(['mcp'], `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: number; result?: { tools?: { name: string }[] } });
    expect(out.map((o) => o.id)).toEqual([1, 2]);
    expect(out[1]?.result?.tools?.map((t) => t.name)).toContain('kt_recall');
  }, 30_000);
});
