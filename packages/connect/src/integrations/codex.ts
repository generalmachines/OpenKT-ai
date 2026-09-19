import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import type { ConnectEnv } from '../types.js';
import { detectAny, hookCommand, hooksEdit, hookScriptEdit, isOpenktCommand, markerBlockEdit, mcpCommand } from './common.js';

/**
 * OpenAI Codex (CLI, IDE extension and desktop app share this config).
 * - MCP: `[mcp_servers.openkt]` with command/args in ~/.codex/config.toml — https://learn.chatgpt.com/docs/extend/mcp?surface=cli
 * - Hooks: ~/.codex/hooks.json, Claude-style events (SessionStart, UserPromptSubmit, Stop with last_assistant_message,
 *   SessionEnd ≤ 3 s), context through hookSpecificOutput.additionalContext — https://learn.chatgpt.com/docs/hooks
 *   Codex runs user hooks only after the person approves them once in /hooks (approval is tied to the hook's hash).
 * The TOML is edited as text between marker lines; a table named openkt written by the old `kt` CLI is replaced.
 */
const BEGIN = '# >>> openkt: managed by openkt-connect, edits inside this block are replaced >>>';
const END = '# <<< openkt <<<';

function codexHome(env: ConnectEnv): string {
  return env.vars['CODEX_HOME'] || join(env.home, '.codex');
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** Remove `[mcp_servers.openkt]` and its sub-tables written outside the markers (the old kt CLI did this). */
function stripLegacyTable(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = header[1] === 'mcp_servers.openkt' || header[1]!.startsWith('mcp_servers.openkt.');
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function conflict(text: string): string | null {
  if (/^\s*mcp_servers\.openkt\s*[.=]/m.test(text) || /^\s*\[mcp_servers\][^[]*^\s*openkt\s*=/ms.test(text)) {
    return 'config.toml defines an openkt MCP server inline; remove that line and connect again';
  }
  return null;
}

export const codex = defineFileIntegration({
  id: 'codex',
  name: 'Codex',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: true, autoRecall: 'prompt', nativeMemorySync: false },
  docs: ['https://learn.chatgpt.com/docs/extend/mcp?surface=cli', 'https://learn.chatgpt.com/docs/hooks'],
  detect: (env) => detectAny(env, [codexHome(env)], 'codex'),
  afterApply: ['Approve the OpenKT hooks once in Codex: type /hooks and trust them. Until then only the MCP tools work. Older Codex versions also need [features] hooks = true in config.toml.'],
  edits(env) {
    const cmd = (event: string) => hookCommand(env, 'codex', event);
    const mcp = mcpCommand(env);
    return [
      hookScriptEdit(env),
      markerBlockEdit({
        file: join(codexHome(env), 'config.toml'),
        part: 'mcp',
        summary: '[mcp_servers.openkt], run by the hook script: no token in the file',
        begin: BEGIN,
        end: END,
        block: `[mcp_servers.openkt]\ncommand = ${tomlString(mcp.command)}\nargs = [${mcp.args.map(tomlString).join(', ')}]\n`,
        stripLegacy: stripLegacyTable,
        conflict,
      }),
      hooksEdit({
        file: join(codexHome(env), 'hooks.json'),
        summary: 'hooks: SessionStart, UserPromptSubmit, Stop, SessionEnd',
        root: ['hooks'],
        entries: {
          SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start'), timeout: 5 }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt'), timeout: 5 }] }],
          Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), timeout: 5 }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: cmd('session-end'), timeout: 3 }] }],
        },
        isOurs: (group) => {
          const hooks = (group as { hooks?: { command?: unknown }[] } | null)?.hooks;
          return Array.isArray(hooks) && hooks.some((h) => isOpenktCommand(h?.command));
        },
      }),
    ];
  },
});
