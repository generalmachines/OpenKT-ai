import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { detectAny, hookCommand, hookScriptEdit, isOpenktCommand, jsonMemberEdit, MCP_NAME, mcpCommand, hooksEdit } from './common.js';

/**
 * Gemini CLI, all in ~/.gemini/settings.json.
 * - MCP: `mcpServers.openkt` {command, args} (no `type` field) — https://geminicli.com/docs/tools/mcp-server/
 * - Hooks: `hooks.<Event>[{matcher?, hooks:[{name, type:'command', command, timeout(ms)}]}]`; SessionStart and
 *   BeforeAgent add `hookSpecificOutput.additionalContext`; AfterAgent carries `prompt_response` — https://geminicli.com/docs/hooks/reference
 * - Native memory: AfterTool on `save_memory` (the tool that writes Gemini's own memories) sends the fact to OpenKT.
 */
export const gemini = defineFileIntegration({
  id: 'gemini',
  name: 'Gemini CLI',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: true, autoRecall: 'prompt', nativeMemorySync: true },
  nativeMemoryNote: 'Also sync Gemini’s own memories: facts it saves with save_memory become OpenKT context.',
  docs: ['https://geminicli.com/docs/tools/mcp-server/', 'https://geminicli.com/docs/hooks/reference'],
  detect: (env) => detectAny(env, [join(env.home, '.gemini')], 'gemini'),
  edits(env, options) {
    const hook = (event: string, timeout = 5000) => ({ hooks: [{ name: `openkt-${event}`, type: 'command', command: hookCommand(env, 'gemini', event), timeout }] });
    const entries: Record<string, unknown[]> = {
      SessionStart: [hook('session-start')],
      BeforeAgent: [hook('prompt')],
      AfterAgent: [hook('stop')],
      SessionEnd: [hook('session-end')],
    };
    if (options.nativeMemory !== false) entries['AfterTool'] = [{ matcher: 'save_memory', ...hook('native-memory') }];
    const settings = join(env.home, '.gemini', 'settings.json');
    return [
      hookScriptEdit(env),
      jsonMemberEdit({ file: settings, part: 'mcp', summary: 'the openkt MCP server, run by the hook script: no token in the file', path: ['mcpServers', MCP_NAME], value: mcpCommand(env) }),
      hooksEdit({
        file: settings,
        summary: options.nativeMemory !== false ? 'hooks: SessionStart, BeforeAgent, AfterAgent, SessionEnd, AfterTool (save_memory)' : 'hooks: SessionStart, BeforeAgent, AfterAgent, SessionEnd',
        root: ['hooks'],
        entries,
        isOurs: (group) => {
          const hooks = (group as { hooks?: { command?: unknown }[] } | null)?.hooks;
          return Array.isArray(hooks) && hooks.some((h) => isOpenktCommand(h?.command));
        },
      }),
    ];
  },
});
