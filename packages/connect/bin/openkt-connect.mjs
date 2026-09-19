#!/usr/bin/env node
/**
 * openkt-connect: connect AI tools to OpenKT from a shell. JSON-first (Spec 06): with --json, or when stdout is not a
 * terminal, stdout is exactly the result object, or {"error":{code,message,hint?}} with a meaningful exit code
 * (2 usage, 3 not signed in, 4 unknown tool / not installed, 5 conflict, 6 unreadable config, 7 network, 1 other).
 * The `kt` CLI (packages/cli) wraps the same functions as `kt connect …` and `kt hook …`.
 *
 *   openkt-connect list                                  every tool: detected, status, capabilities
 *   openkt-connect status [<tool>]                       status (+ credentials) for one tool or all
 *   openkt-connect connect <tool> [--undo] [--dry-run] [--no-native-memory] [--force]
 *   openkt-connect guide <tool>                          steps for tools set up in their own UI (claude-ai, chatgpt, agent)
 *   openkt-connect test [<tool>]                         a real session-start → prompt → session-end through the hook script
 *   openkt-connect hook <tool> <event>                   the hook core in Node (stdin: the tool's hook JSON)
 *   openkt-connect folders                               folder → space mappings (and folders waiting for a decision)
 *   openkt-connect folders map <path> <space_id|personal> [--name <space name>]
 *   openkt-connect auth status | login --email <e> --password-stdin [--server <url>] | set --token-stdin [--server <url>] | logout
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as connect from '../dist/index.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(['--email', '--server', '--name']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''));
const json = flags.has('--json') || !process.stdout.isTTY;

function print(result, human) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${human(result)}\n`);
}

function fail(err) {
  const e = err instanceof connect.ConnectError ? err : new connect.ConnectError('internal', err instanceof Error ? err.message : String(err));
  if (json) process.stdout.write(`${JSON.stringify(e.toJSON())}\n`);
  else process.stderr.write(`openkt-connect: ${e.message}${e.hint ? `\n  ${e.hint}` : ''}\n`);
  process.exit(e.exitCode);
}

const usage = (msg) => new connect.ConnectError('usage', msg, { hint: 'run: openkt-connect --help' });

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const describe = (t) => {
  const caps = [t.capabilities.autoCapture && 'saves sessions', t.capabilities.autoRecall && `recalls (${t.capabilities.autoRecall})`, t.capabilities.nativeMemorySync && 'syncs its memory', t.capabilities.mcp && 'MCP tools'].filter(Boolean).join(', ');
  return `${t.status.padEnd(15)} ${t.id.padEnd(15)} ${t.detected.installed ? 'found   ' : 'not found'} ${caps}${t.reasons.length ? `\n${' '.repeat(16)}${t.reasons.join('; ')}` : ''}`;
};
const describeChanges = (r) => (r.changes.length ? r.changes.map((c) => `${c.action.padEnd(7)} ${c.file}\n        ${c.summary}`).join('\n') : 'nothing to change');

async function main() {
  const env = connect.systemEnv();
  const [cmd, ...rest] = positional;
  if (!cmd || flags.has('--help')) {
    process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith(' *   ')).map((l) => l.slice(3)).join('\n') + '\n');
    return;
  }
  if (cmd === 'list' || flags.has('--list')) {
    const tools = await connect.listTools(env);
    return print({ tools }, (r) => r.tools.map(describe).join('\n'));
  }
  if (cmd === 'status') {
    const credentials = await connect.readCredentials(env);
    const signedIn = { server: credentials.server, signed_in: credentials.token !== null, source: credentials.source };
    if (rest[0]) return print({ ...(await connect.toolInfo(env, rest[0])), credentials: signedIn }, describe);
    const tools = await connect.listTools(env);
    return print({ credentials: signedIn, tools }, (r) => `${r.credentials.signed_in ? `signed in to ${r.credentials.server} (${r.credentials.source})` : `not signed in (${r.credentials.server})`}\n${r.tools.map(describe).join('\n')}`);
  }
  if (cmd === 'connect') {
    const id = rest[0];
    if (!id) throw usage('connect needs a tool id');
    const options = { nativeMemory: !flags.has('--no-native-memory') };
    if (flags.has('--dry-run')) return print({ tool: id, plan: flags.has('--undo') ? [] : await connect.planTool(env, id, options) }, (r) => (r.plan.length ? r.plan.map((c) => `${c.action.padEnd(7)} ${c.file}\n        ${c.summary}`).join('\n') : 'nothing to change'));
    const result = flags.has('--undo') ? await connect.disconnectTool(env, id) : await connect.connectTool(env, id, options, flags.has('--force'));
    return print(result, (r) => `${describeChanges(r)}\n${describe(r.tool)}`);
  }
  if (cmd === 'guide') {
    if (!rest[0]) throw usage('guide needs a tool id');
    const guide = await connect.guideTool(env, rest[0]);
    return print({ tool: rest[0], guide }, (r) => (r.guide ? [r.guide.blocked ? `blocked: ${r.guide.blocked}` : '', r.guide.openUrl ? `open: ${r.guide.openUrl}` : '', r.guide.copy ? `copy: ${r.guide.copy}` : '', ...r.guide.steps.map((s, i) => `${i + 1}. ${s}`)].filter(Boolean).join('\n') : 'this tool is connected from disk: openkt-connect connect ' + r.tool));
  }
  if (cmd === 'test') {
    const result = await connect.selfTest(env, rest[0] ?? 'agent');
    print(result, (r) => (r.ok ? `ok: session ${r.session_id}` : `failed: ${r.problem}`) + `\n${r.steps.map((s) => `  ${s.event.padEnd(14)} ${s.ms} ms`).join('\n')}`);
    if (!result.ok) process.exitCode = result.session_id ? 1 : 7;
    return;
  }
  if (cmd === 'hook') {
    const [tool, event] = rest;
    if (!tool || !connect.HOOK_EVENTS.includes(event)) throw usage(`hook needs a tool and one of: ${connect.HOOK_EVENTS.join(', ')}`);
    const result = await connect.runHook(tool, event, readStdin(), { env, cwd: process.cwd() });
    process.stdout.write(result.stdout);
    return;
  }
  if (cmd === 'folders') {
    if (rest[0] === 'map') {
      const [, path, space] = rest;
      if (!path || !space) throw usage('folders map needs <path> <space_id|personal>');
      connect.mapFolder(env, resolve(path), space === 'personal' ? null : space, valueOf('--name'));
    }
    const folders = connect.listFolders(env);
    return print({ folders }, (r) => r.folders.map((f) => `${f.state.padEnd(9)} ${f.path}${f.space_name ? `  → ${f.space_name}` : f.space_id ? `  → ${f.space_id}` : ''}`).join('\n') || 'no folders yet');
  }
  if (cmd === 'auth') {
    const sub = rest[0] ?? 'status';
    if (sub === 'status') {
      const c = await connect.readCredentials(env);
      return print({ server: c.server, signed_in: c.token !== null, source: c.source }, (r) => (r.signed_in ? `signed in to ${r.server} (${r.source})` : `not signed in (${r.server})`));
    }
    if (sub === 'logout') {
      await connect.clearCredentials(env);
      return print({ signed_in: false }, () => 'signed out on this machine');
    }
    const server = (valueOf('--server') ?? (await connect.readCredentials(env)).server).replace(/\/+$/, '');
    let token;
    if (sub === 'set') {
      if (!flags.has('--token-stdin')) throw usage('auth set reads the token from stdin: --token-stdin');
      token = readStdin().trim();
    } else if (sub === 'login') {
      const email = valueOf('--email');
      if (!email || !flags.has('--password-stdin')) throw usage('auth login needs --email and --password-stdin');
      const res = await connect.call(fetch, server, 'POST', '/v1/auth/login', { body: { email, password: readStdin().replace(/\n$/, ''), client: 'cli' } });
      if (res.status !== 200 || !res.data?.token) throw new connect.ConnectError(res.status === 0 ? 'network' : 'unauthorized', res.error?.message ?? `login answered ${res.status}`);
      token = res.data.token;
    } else throw usage(`unknown auth command ${sub}`);
    if (!/^okt_pat_[A-Za-z0-9]+$/.test(token)) throw new connect.ConnectError('invalid', 'that does not look like an OpenKT token (okt_pat_…)');
    const where = await connect.writeCredentials(env, { server, token });
    return print({ server, signed_in: true, source: where }, (r) => `signed in to ${r.server}; the token is in the ${r.source === 'keychain' ? 'macOS keychain' : '~/.openkt/credentials.json (mode 600)'}`);
  }
  throw usage(`unknown command ${cmd}`);
}

main().catch(fail);
