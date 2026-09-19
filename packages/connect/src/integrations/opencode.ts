import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { xdgConfig } from '../env.js';
import { detectAny, hookScriptEdit, jsonMemberEdit, MCP_NAME, mcpCommand } from './common.js';

/**
 * OpenCode: ~/.config/opencode/opencode.json `mcp.openkt` {type:'local', command:[…], enabled:true} —
 * https://opencode.ai/docs/mcp-servers/ and https://opencode.ai/docs/config/
 * OpenCode has JS plugins instead of command hooks, and no documented way for a plugin to add context to a prompt,
 * so this integration is MCP only — https://opencode.ai/docs/plugins/
 */
export const opencode = defineFileIntegration({
  id: 'opencode',
  name: 'OpenCode',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: false, autoRecall: false, nativeMemorySync: false },
  docs: ['https://opencode.ai/docs/mcp-servers/', 'https://opencode.ai/docs/config/'],
  detect: (env) => detectAny(env, [join(xdgConfig(env), 'opencode'), join(env.home, '.opencode')], 'opencode'),
  edits: (env) => {
    const mcp = mcpCommand(env);
    return [
      hookScriptEdit(env),
      jsonMemberEdit({
        file: join(xdgConfig(env), 'opencode', 'opencode.json'),
        part: 'mcp',
        summary: 'the openkt MCP server, run by the hook script: no token in the file',
        path: ['mcp', MCP_NAME],
        value: { type: 'local', command: [mcp.command, ...mcp.args], enabled: true },
        seed: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
      }),
    ];
  },
});
