import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeEnv } from '../src/env.js';
import { mapFolder } from '../src/folders.js';
import { runHook, type HookEvent } from '../src/hook.js';
import type { Credentials } from '../src/credentials.js';
import type { ConnectEnv } from '../src/types.js';
import { FakeServer, memory } from './support/fake-server.js';

const TOKEN = 'okt_pat_nodehook';
let home: string;
let env: ConnectEnv;
let server: FakeServer;

const creds = (over: Partial<Credentials> = {}): Credentials => ({ server: server.url, token: TOKEN, source: 'env', ...over });
const hook = (tool: string, event: HookEvent, input: unknown, over: Partial<Credentials> = {}) => runHook(tool, event, JSON.stringify(input), { env, credentials: creds(over) });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'okt-nhook-'));
  env = homeEnv(home);
  server = await new FakeServer({ token: TOKEN, memories: [memory('Billing webhooks must check the idempotency table first.', 'Ana')] }).start();
});
afterEach(async () => {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('runHook (Node core, same protocol as the sh script)', () => {
  it('session-start → prompt → stop → session-end', async () => {
    const start = await hook('claude-code', 'session-start', { session_id: 's1', cwd: home });
    const ctx = (JSON.parse(start.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
    expect(ctx.hookEventName).toBe('SessionStart');
    const session = [...server.sessions.values()][0]!;
    expect(ctx.additionalContext).toContain(`OpenKT session ${session.id}`);
    expect(ctx.additionalContext).toContain('— Ana');

    const prompt = await hook('claude-code', 'prompt', { session_id: 's1', cwd: home, prompt: 'how do billing webhooks work?' });
    expect(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext).toMatch(/^Context from OpenKT/);
    await hook('claude-code', 'stop', { session_id: 's1', cwd: home, last_assistant_message: 'They check the table.' });
    expect(session.turns).toEqual([
      { role: 'user', content: 'how do billing webhooks work?' },
      { role: 'assistant', content: 'They check the table.' },
    ]);
    await hook('claude-code', 'session-end', { session_id: 's1', cwd: home });
    expect(session.status).toBe('closed');
    expect(existsSync(join(home, '.openkt/state/sessions/claude-code__s1'))).toBe(false);
  });

  it('offline and signed out: no output, queued, flushed in order by the next call', async () => {
    expect((await hook('codex', 'prompt', { session_id: 'q', cwd: home, prompt: 'queued while signed out' }, { token: null })).stdout).toBe('');
    expect((await hook('codex', 'stop', { session_id: 'q', cwd: home, last_assistant_message: 'reply' }, { server: 'http://127.0.0.1:9' })).stdout).toBe('');
    expect(readdirSync(join(home, '.openkt/outbox')).filter((n) => n.endsWith('.req'))).toHaveLength(2);
    await hook('codex', 'session-end', { session_id: 'other', cwd: home });
    const s = [...server.sessions.values()][0]!;
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(readdirSync(join(home, '.openkt/outbox')).filter((n) => n.endsWith('.req'))).toEqual([]);
  });

  it('recall gives up at the timeout', async () => {
    await server.stop();
    server = await new FakeServer({ token: TOKEN, delays: { 'POST /v1/memories/recall': 3000 } }).start();
    const t = Date.now();
    const r = await runHook('claude-code', 'prompt', JSON.stringify({ session_id: 't', cwd: home, prompt: 'slow recall should not block' }), { env, credentials: creds(), recallTimeoutMs: 300 });
    expect(r.stdout).toBe('');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('uses the folder mapping and reads the same folders.json the sh script reads', async () => {
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    mapFolder(env, join(home, 'repo'), 'space-9', 'Team');
    await hook('agent', 'session-start', { session_id: 'f', cwd: join(home, 'repo') });
    expect([...server.sessions.values()][0]!.body['project_id']).toBe('space-9');
    expect(readFileSync(join(home, '.openkt/folders.json'), 'utf8')).toContain(`"${join(home, 'repo')}": {"space_id": "space-9"`);
  });

  it('native memory from a Claude Code memory file', async () => {
    const f = join(home, '.claude/projects/-x/memory/rule.md');
    mkdirSync(join(home, '.claude/projects/-x/memory'), { recursive: true });
    writeFileSync(f, '---\nname: Rule\ntype: feedback\n---\nNever mock the database in integration tests.\n');
    await hook('claude-code', 'native-memory', { session_id: 'n', tool_name: 'Write', tool_input: { file_path: f } });
    expect(server.of('POST', '/v1/memories')[0]?.body).toMatchObject({ content: 'Rule\n\nNever mock the database in integration tests.', kind: 'anti-pattern', tag_slugs: ['native-memory', 'feedback'] });
    await hook('claude-code', 'native-memory', { session_id: 'n', tool_name: 'Write', tool_input: { file_path: f } });
    expect(server.of('POST', '/v1/memories')).toHaveLength(1);
  });

  it('agent dialect always answers {context_md}', async () => {
    const r = await hook('agent', 'prompt', { session_id: 'a', cwd: home, prompt: 'tell me about billing' });
    expect(JSON.parse(r.stdout)).toHaveProperty('context_md');
  });
});
