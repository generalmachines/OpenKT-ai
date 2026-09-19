import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_SCRIPT } from '../src/assets.generated.js';
import { mapFolder } from '../src/folders.js';
import { homeEnv } from '../src/env.js';
import { FakeServer, memory } from './support/fake-server.js';

const SCRIPT = join(__dirname, '..', 'assets', 'openkt-hook.sh');
const TOKEN = 'okt_pat_testtoken123';

interface Run {
  code: number | null;
  stdout: string;
  ms: number;
}

let home: string;
let server: FakeServer;

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  // Never inherit a real OPENKT_TOKEN / OPENKT_SERVER from the machine running the tests.
  const env: Record<string, string> = {};
  // OPENKT_AWK / OPENKT_GREP pass through, so the suite can run against another awk (e.g. BWK awk, as on macOS).
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ((!k.startsWith('OPENKT_') && !k.startsWith('CLAUDE')) || k === 'OPENKT_AWK' || k === 'OPENKT_GREP')) env[k] = v;
  return { ...env, HOME: home, OPENKT_HOME: join(home, '.openkt'), OPENKT_NO_KEYCHAIN: '1', OPENKT_SERVER: server.url, OPENKT_TOKEN: TOKEN, ...extra };
}

function run(args: string[], stdin: unknown, extra: Record<string, string> = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    // OPENKT_TEST_SHELL=bash runs the suite under bash (macOS /bin/sh is bash 3.2 in POSIX mode); the default is dash.
    const shell = process.env['OPENKT_TEST_SHELL'] === 'bash' ? ['bash', '--posix'] : ['/bin/sh'];
    const child = spawn(shell[0]!, [...shell.slice(1), SCRIPT, ...args], { env: baseEnv(extra), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout: out, ms: Date.now() - started }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

const context = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'okt-hook-'));
  server = await new FakeServer({ token: TOKEN, memories: [memory('Billing webhooks must check the idempotency table first.', 'Ana')] }).start();
});

afterEach(async () => {
  // Detached writes may still be finishing.
  await new Promise((r) => setTimeout(r, 300));
  await server.stop();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('openkt-hook.sh', () => {
  it('is the script that gets installed', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toBe(HOOK_SCRIPT);
    expect(spawnSync('/bin/sh', ['-n', SCRIPT]).status).toBe(0);
  });

  it('session-start creates the session and prints the brief in the SessionStart hook shape', async () => {
    const r = await run(['claude-code', 'session-start'], { session_id: 'cc-1', cwd: home, hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PROJECT_DIR: home });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('space: Personal');
    expect(ctx).toContain('The team ships on Fridays.');
    expect(ctx).toContain('Billing webhooks must check the idempotency table first. — Ana');
    const [session] = [...server.sessions.values()];
    expect(session?.body).toMatchObject({ source: 'claude-code', client: 'claude-code', metadata: { client_session_id: 'cc-1', cwd: home } });
    expect(ctx).toContain(`OpenKT session ${session!.id}`);
    expect(readFileSync(join(home, '.openkt/state/sessions/claude-code__cc-1'), 'utf8')).toBe(session!.id);
  });

  it('labels sessions from VS Code Copilot, which also runs ~/.claude/settings.json hooks, as vscode', async () => {
    await run(['claude-code', 'session-start'], { session_id: 'vs-1', cwd: home, source: 'new' }, { VSCODE_PID: '123' });
    expect([...server.sessions.values()][0]?.body).toMatchObject({ source: 'connector', client: 'vscode' });
  });

  it('prompt saves the turn and returns recalled context in the UserPromptSubmit shape', async () => {
    await run(['claude-code', 'session-start'], { session_id: 'cc-2', cwd: home });
    const prompt = 'How do we handle "billing" webhooks?\nTwo lines, a tab\there and café.';
    const r = await run(['claude-code', 'prompt'], { session_id: 'cc-2', cwd: home, hook_event_name: 'UserPromptSubmit', prompt });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/^Context from OpenKT that may be relevant/);
    expect(out.hookSpecificOutput.additionalContext).toContain('— Ana, Personal, 2026-09-18');
    expect((server.of('POST', '/v1/memories/recall')[0]?.body as { query: string }).query).toBe(prompt);
    await server.waitFor(() => [...server.sessions.values()][0]!.turns.length === 1);
    expect([...server.sessions.values()][0]!.turns[0]).toEqual({ role: 'user', content: prompt });
  });

  it('drops recalled items below the similarity floor and prints nothing when none are left', async () => {
    server.memories.splice(0, 1, memory('Unrelated thing.', 'Bo', 0.2));
    const r = await run(['claude-code', 'prompt'], { session_id: 'cc-3', cwd: home, prompt: 'something long enough to recall' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('keeps context within 1,500 characters', async () => {
    server.memories.splice(0, 1, ...Array.from({ length: 12 }, (_, i) => memory(`${'x'.repeat(380)} item ${i}`, 'Ana')));
    const r = await run(['claude-code', 'prompt'], { session_id: 'cc-4', cwd: home, prompt: 'give me everything about x' });
    expect(context(r.stdout).length).toBeLessThanOrEqual(1500);
  });

  it('stop sends the assistant reply; session-end closes the session and forgets the mapping', async () => {
    await run(['claude-code', 'session-start'], { session_id: 'cc-5', cwd: home });
    const s = [...server.sessions.values()][0]!;
    await run(['claude-code', 'stop'], { session_id: 'cc-5', cwd: home, last_assistant_message: 'Done: fixed in refund.ts', stop_hook_active: false });
    await server.waitFor(() => s.turns.length === 1);
    expect(s.turns[0]).toEqual({ role: 'assistant', content: 'Done: fixed in refund.ts' });
    const end = await run(['claude-code', 'session-end'], { session_id: 'cc-5', cwd: home, reason: 'prompt_input_exit' });
    expect(end.stdout).toBe('');
    expect(await server.waitFor(() => s.status === 'closed')).toBe(true);
    expect(await server.waitFor(() => !existsSync(join(home, '.openkt/state/sessions/claude-code__cc-5')))).toBe(true);
  });

  it('offline: exits 0 fast with no output, and queues the turn in the outbox', async () => {
    const r = await run(['claude-code', 'prompt'], { session_id: 'cc-6', cwd: home, prompt: 'this prompt happens while offline' }, { OPENKT_SERVER: 'http://127.0.0.1:9' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(2000);
    const outbox = join(home, '.openkt/outbox');
    expect(await server.waitFor(() => existsSync(outbox) && readdirSync(outbox).some((n) => n.endsWith('.req')))).toBe(true);
  });

  it('signed out: answers with nothing, queues, and the next call after sign-in flushes the outbox in order', async () => {
    const r = await run(['claude-code', 'prompt'], { session_id: 'cc-7', cwd: home, prompt: 'first prompt, signed out' }, { OPENKT_TOKEN: '' });
    expect(r.stdout).toBe('');
    await run(['claude-code', 'stop'], { session_id: 'cc-7', cwd: home, last_assistant_message: 'reply while signed out' }, { OPENKT_TOKEN: '' });
    expect(server.requests).toHaveLength(0);
    const flush = await run(['flush'], '');
    expect(flush.code).toBe(0);
    const s = [...server.sessions.values()][0]!;
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(readdirSync(join(home, '.openkt/outbox')).filter((n) => n.endsWith('.req'))).toEqual([]);
  });

  it('never blocks longer than 2 s when the server is slow: recall gives up at 1.2 s', async () => {
    await server.stop();
    server = await new FakeServer({ token: TOKEN, delays: { 'POST /v1/memories/recall': 4000, 'POST /v1/prime': 4000, 'POST /v1/sessions': 4000 } }).start();
    const p = await run(['claude-code', 'prompt'], { session_id: 'cc-8', cwd: home, prompt: 'a slow server should not hold this up' });
    expect(p.code).toBe(0);
    expect(p.ms).toBeLessThan(2000);
    const s = await run(['claude-code', 'session-start'], { session_id: 'cc-9', cwd: home });
    expect(s.ms).toBeLessThan(2000);
  });

  it('maps a folder to a space: manifest, then folders.json; unknown git repos go to personal and are noted', async () => {
    const repo = join(home, 'code', 'acme');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    await run(['claude-code', 'session-start'], { session_id: 'm-1', cwd: join(repo, 'src') });
    expect([...server.sessions.values()][0]!.body['project_id']).toBeUndefined();
    expect(readFileSync(join(home, '.openkt/folders.pending'), 'utf8')).toMatch(new RegExp(`^${repo}\\t`));

    mapFolder(homeEnv(home), repo, 'space-acme', 'Acme');
    await run(['claude-code', 'session-start'], { session_id: 'm-2', cwd: join(repo, 'src') });
    expect([...server.sessions.values()][1]!.body['project_id']).toBe('space-acme');
    expect((server.of('POST', '/v1/prime')[1]?.body as { project_id?: string }).project_id).toBe('space-acme');

    mkdirSync(join(repo, 'src', '.openkt'), { recursive: true });
    writeFileSync(join(repo, 'src', '.openkt', 'manifest.json'), JSON.stringify({ project_id: 'space-from-manifest', slug: 'x' }));
    await run(['claude-code', 'session-start'], { session_id: 'm-3', cwd: join(repo, 'src') });
    expect([...server.sessions.values()][2]!.body['project_id']).toBe('space-from-manifest');
  });

  it('a folder filed under a space that refuses the session falls back to the personal space', async () => {
    await server.stop();
    server = await new FakeServer({ token: TOKEN }).start();
    const original = server.url;
    mapFolder(homeEnv(home), home, 'space-gone', 'Gone');
    // The fake accepts any project_id; make it refuse this one.
    const handle = (server as unknown as { handle: (...a: unknown[]) => Promise<void> }).handle.bind(server);
    (server as unknown as { handle: unknown }).handle = async (req: { url?: string; method?: string }, res: { writeHead: (s: number, h: object) => void; end: (b: string) => void }) => {
      if (req.method === 'POST' && req.url === '/v1/sessions') {
        const chunks: Buffer[] = [];
        for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c);
        const body = Buffer.concat(chunks).toString();
        server.requests.push({ method: 'POST', path: '/v1/sessions', auth: undefined, body: JSON.parse(body), raw: body });
        if (body.includes('space-gone')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: null, error: { code: 'not_found', message: 'project' } }));
        }
        const id = '99999999-8888-7777-6666-555555555555';
        server.sessions.set(id, { id, project_id: 'personal', status: 'open', turns: [], body: JSON.parse(body) });
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: { id }, error: null, meta: null }));
      }
      return handle(req, res);
    };
    expect(server.url).toBe(original);
    await run(['claude-code', 'session-start'], { session_id: 'gone-1', cwd: home });
    const creates = server.of('POST', '/v1/sessions');
    expect(creates.map((c) => (c.body as { project_id?: string }).project_id)).toEqual(['space-gone', undefined]);
    expect(readFileSync(join(home, '.openkt/state/sessions/claude-code__gone-1'), 'utf8')).toBe('99999999-8888-7777-6666-555555555555');
  });

  it('native memory: a Claude Code memory file becomes one fact; an edit replaces it; other files are ignored', async () => {
    const dir = join(home, '.claude', 'projects', '-code-acme', 'memory');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'deploy.md');
    writeFileSync(file, '---\nname: Deploy rule\ntype: project\n---\nWe deploy with `make ship`, never on Fridays.\n');
    await run(['claude-code', 'native-memory'], { session_id: 'n-1', cwd: home, tool_name: 'Write', tool_input: { file_path: file } });
    expect(await server.waitFor(() => server.of('POST', '/v1/memories').length === 1)).toBe(true);
    const saved = server.of('POST', '/v1/memories')[0]!.body as { content: string; kind: string; tag_slugs: string[] };
    expect(saved).toMatchObject({ content: 'Deploy rule\n\nWe deploy with `make ship`, never on Fridays.', kind: 'decision', tag_slugs: ['native-memory', 'project'] });

    await run(['claude-code', 'native-memory'], { session_id: 'n-1', cwd: home, tool_name: 'Edit', tool_input: { file_path: file } });
    await new Promise((r) => setTimeout(r, 400));
    expect(server.of('POST', '/v1/memories')).toHaveLength(1);

    writeFileSync(file, '---\nname: Deploy rule\ntype: project\n---\nWe deploy with `make ship` on any weekday.\n');
    await run(['claude-code', 'native-memory'], { session_id: 'n-1', cwd: home, tool_name: 'Edit', tool_input: { file_path: file } });
    expect(await server.waitFor(() => server.of('DELETE', '/v1/memories/').length === 1)).toBe(true);
    expect(server.of('POST', '/v1/memories')).toHaveLength(2);

    await run(['claude-code', 'native-memory'], { session_id: 'n-1', cwd: home, tool_name: 'Write', tool_input: { file_path: join(dir, 'MEMORY.md') } });
    await run(['claude-code', 'native-memory'], { session_id: 'n-1', cwd: home, tool_name: 'Write', tool_input: { file_path: join(home, 'notes.md') } });
    await new Promise((r) => setTimeout(r, 400));
    expect(server.of('POST', '/v1/memories')).toHaveLength(2);
  });

  it('speaks each tool’s hook dialect', async () => {
    const codex = await run(['codex', 'prompt'], { session_id: 'x-1', cwd: home, prompt: 'billing webhooks again please' });
    expect(JSON.parse(codex.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const gemini = await run(['gemini', 'prompt'], { session_id: 'g-1', cwd: home, prompt: 'billing webhooks again please' });
    expect(JSON.parse(gemini.stdout).hookSpecificOutput.hookEventName).toBe('BeforeAgent');
    const cursorStart = await run(['cursor', 'session-start'], { conversation_id: 'c-1', workspace_roots: [home] });
    expect(JSON.parse(cursorStart.stdout).additional_context).toContain('Billing webhooks');
    const cursorPrompt = await run(['cursor', 'prompt'], { conversation_id: 'c-1', prompt: 'hello from cursor' });
    expect(JSON.parse(cursorPrompt.stdout)).toEqual({ continue: true });
    const agent = await run(['agent', 'prompt'], { session_id: 'a-1', cwd: home, prompt: 'billing webhooks again please' });
    expect(JSON.parse(agent.stdout).context_md).toContain('Ana');
    await run(['windsurf', 'prompt'], { trajectory_id: 'w-1', tool_info: { user_prompt: 'from windsurf' } });
    expect(await server.waitFor(() => [...server.sessions.values()].some((s) => s.turns.some((t) => t.content === 'from windsurf')))).toBe(true);
    const cursorSession = [...server.sessions.values()].find((s) => (s.body['metadata'] as { client_session_id: string }).client_session_id === 'c-1');
    expect(cursorSession?.body).toMatchObject({ source: 'connector', client: 'cursor' });
  });

  it('gemini save_memory facts are synced as native memory', async () => {
    await run(['gemini', 'native-memory'], { session_id: 'g-2', cwd: home, tool_name: 'save_memory', tool_input: { fact: 'Pratham prefers pnpm.' } });
    expect(await server.waitFor(() => server.of('POST', '/v1/memories').length === 1)).toBe(true);
    expect(server.of('POST', '/v1/memories')[0]!.body).toMatchObject({ content: 'Pratham prefers pnpm.', tag_slugs: ['native-memory', 'gemini'] });
  });

  it('mcp: forwards JSON-RPC lines with the stored token and keeps the Mcp-Session-Id', async () => {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ];
    const r = await run(['mcp'], `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: number; result: { echo: string; session: string | null } });
    expect(out).toEqual([
      { jsonrpc: '2.0', id: 1, result: { echo: 'initialize', session: null } },
      { jsonrpc: '2.0', id: 2, result: { echo: 'tools/list', session: 'fake-mcp-session' } },
    ]);
    expect(server.of('POST', '/mcp').every((q) => q.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('mcp: signed out answers each request with an error the model can relay', async () => {
    const r = await run(['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`, { OPENKT_TOKEN: '' });
    const out = JSON.parse(r.stdout) as { id: number; error: { message: string } };
    expect(out.id).toBe(7);
    expect(out.error.message).toMatch(/not signed in/);
  });

  it('reads the token from ~/.openkt/credentials.json and never writes it to the log or leaves it on disk', async () => {
    mkdirSync(join(home, '.openkt'), { recursive: true });
    writeFileSync(join(home, '.openkt', 'credentials.json'), JSON.stringify({ server: server.url, token: TOKEN }), { mode: 0o600 });
    const r = await run(['claude-code', 'prompt'], { session_id: 'k-1', cwd: home, prompt: 'billing webhooks via the file token' }, { OPENKT_TOKEN: '', OPENKT_SERVER: '' });
    expect(context(r.stdout)).toContain('Ana');
    await server.waitFor(() => server.of('POST', '/v1/sessions/').length === 1);
    await new Promise((r2) => setTimeout(r2, 300));
    const run_dir = join(home, '.openkt', 'run');
    expect(existsSync(run_dir) ? readdirSync(run_dir) : []).toEqual([]);
    const log = existsSync(join(home, '.openkt/logs/hook.log')) ? readFileSync(join(home, '.openkt/logs/hook.log'), 'utf8') : '';
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('billing webhooks');
  });

  it.each(['mawk', 'busybox'])('works with %s as awk', async (awk) => {
    const bin = spawnSync('sh', ['-c', `command -v ${awk}`]).stdout.toString().trim();
    if (!bin) return;
    const wrapper = join(home, `awk-${awk}`);
    writeFileSync(wrapper, awk === 'busybox' ? `#!/bin/sh\nexec ${bin} awk "$@"\n` : `#!/bin/sh\nexec ${bin} "$@"\n`, { mode: 0o755 });
    const r = await run(['claude-code', 'prompt'], { session_id: `awk-${awk}`, cwd: home, prompt: 'billing "webhooks" with café and\ttabs' }, { OPENKT_AWK: wrapper });
    expect(context(r.stdout)).toContain('— Ana');
    await server.waitFor(() => [...server.sessions.values()].some((s) => s.turns.length === 1));
    expect([...server.sessions.values()][0]!.turns[0]!.content).toBe('billing "webhooks" with café and\ttabs');
  });
});
