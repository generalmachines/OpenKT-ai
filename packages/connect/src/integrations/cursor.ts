import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { appSupport } from '../env.js';
import { detectAny, hookCommand, hooksEdit, hookScriptEdit, isOpenktCommand, jsonMemberEdit, MCP_NAME, mcpCommand } from './common.js';

/**
 * Cursor.
 * - MCP: ~/.cursor/mcp.json `mcpServers.openkt` {type:'stdio', command, args} — https://cursor.com/docs/context/mcp
 * - Hooks: ~/.cursor/hooks.json {version:1, hooks:{<event>:[{command, timeout}]}} — https://cursor.com/docs/agent/hooks
 *   beforeSubmitPrompt cannot add context (it may only continue or stop), so recall happens once, at sessionStart
 *   (`additional_context`); prompts and replies (afterAgentResponse `text`) are still saved as turns.
 * - Rules: Cursor keeps user rules in its settings UI only (no file), so the behaviour contract comes from the MCP
 *   server's own instructions — https://cursor.com/docs/context/rules
 */
export const cursor = defineFileIntegration({
  id: 'cursor',
  name: 'Cursor',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: true, autoRecall: 'session-start', nativeMemorySync: false },
  docs: ['https://cursor.com/docs/context/mcp', 'https://cursor.com/docs/agent/hooks'],
  detect: (env) => detectAny(env, [join(env.home, '.cursor'), '/Applications/Cursor.app', join(appSupport(env), 'Cursor')], 'cursor'),
  edits(env) {
    const hook = (event: string) => ({ command: hookCommand(env, 'cursor', event), timeout: 5 });
    return [
      hookScriptEdit(env),
      jsonMemberEdit({
        file: join(env.home, '.cursor', 'mcp.json'),
        part: 'mcp',
        summary: 'the openkt MCP server, run by the hook script: no token in the file',
        path: ['mcpServers', MCP_NAME],
        value: { type: 'stdio', ...mcpCommand(env) },
      }),
      hooksEdit({
        file: join(env.home, '.cursor', 'hooks.json'),
        summary: 'hooks: sessionStart, beforeSubmitPrompt, afterAgentResponse, sessionEnd',
        root: ['hooks'],
        seed: '{\n  "version": 1\n}\n',
        entries: {
          sessionStart: [hook('session-start')],
          beforeSubmitPrompt: [hook('prompt')],
          afterAgentResponse: [hook('stop')],
          sessionEnd: [hook('session-end')],
        },
        isOurs: (entry) => isOpenktCommand((entry as { command?: unknown } | null)?.command),
      }),
    ];
  },
});
