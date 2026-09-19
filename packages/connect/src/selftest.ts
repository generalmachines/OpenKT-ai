import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hookScriptPath } from './integrations/common.js';
import type { ConnectEnv } from './types.js';

export interface SelfTestStep {
  event: string;
  ms: number;
  output: string;
}

export interface SelfTestResult {
  ok: boolean;
  /** The OpenKT session the test created (visible in the app and at GET /v1/sessions/:id). */
  session_id: string | null;
  context_md: string;
  steps: SelfTestStep[];
  problem?: string;
}

function runScript(env: ConnectEnv, args: string[], stdin: string, extraEnv: Record<string, string>): Promise<{ ms: number; stdout: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [hookScriptPath(env), ...args], {
      env: { ...process.env, HOME: env.home, OPENKT_HOME: env.openktHome, ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', () => resolve({ ms: Date.now() - started, stdout: out }));
    child.on('error', () => resolve({ ms: Date.now() - started, stdout: '' }));
    child.stdin.end(stdin);
  });
}

function contextOf(stdout: string): string {
  try {
    const o = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string }; additional_context?: string; context_md?: string };
    return o.hookSpecificOutput?.additionalContext ?? o.additional_context ?? o.context_md ?? '';
  } catch {
    return stdout;
  }
}

/**
 * Fires a real session-start → prompt → stop → session-end through the installed hook script, exactly as a tool
 * would, and reports the session it created. Uses the tool's own id so the session is labelled like a real one.
 */
export async function selfTest(env: ConnectEnv, tool = 'agent', extraEnv: Record<string, string> = {}): Promise<SelfTestResult> {
  if (!existsSync(hookScriptPath(env))) return { ok: false, session_id: null, context_md: '', steps: [], problem: 'the hook script is not installed: connect a tool first' };
  const sid = `openkt-selftest-${Date.now()}`;
  const cwd = env.home;
  const steps: SelfTestStep[] = [];
  const fire = async (event: string, payload: Record<string, unknown>) => {
    const r = await runScript(env, [tool, event], JSON.stringify({ session_id: sid, cwd, ...payload }), extraEnv);
    steps.push({ event, ms: r.ms, output: r.stdout.trim() });
    return r.stdout;
  };
  const start = contextOf(await fire('session-start', { source: 'startup' }));
  const session = /OpenKT session ([0-9a-f-]{36})/.exec(start)?.[1] ?? null;
  await fire('prompt', { prompt: 'OpenKT connection test: is this tool connected?' });
  await fire('stop', { last_assistant_message: 'Yes. This session was saved by the OpenKT connection test and can be deleted.' });
  await fire('session-end', { reason: 'other' });
  // session-end closes in the background; wait for it (and the turns before it) to leave the machine.
  const mapFile = join(env.openktHome, 'state', 'sessions', `${tool.replace(/[^A-Za-z0-9._-]/g, '_')}__${sid}`);
  const outbox = join(env.openktHome, 'outbox');
  for (let i = 0; i < 50 && (existsSync(mapFile) || (existsSync(outbox) && readdirSync(outbox).some((n) => n.endsWith('.req')))); i++) await new Promise((r) => setTimeout(r, 200));
  const slow = steps.find((s) => s.ms > 2000);
  const problem = !session ? 'no session was created: check that you are signed in and the server is reachable' : slow ? `${slow.event} took ${slow.ms} ms` : existsSync(mapFile) ? 'the session did not close yet (it will from the outbox)' : undefined;
  return { ok: !!session && !slow, session_id: session, context_md: start, steps, ...(problem ? { problem } : {}) };
}
