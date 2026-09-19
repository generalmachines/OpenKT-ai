import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { appSupport } from '../env.js';
import { detectAny, hookScriptEdit, jsonMemberEdit, MCP_NAME, mcpCommand } from './common.js';

/**
 * VS Code (GitHub Copilot agent mode): user-profile mcp.json `servers.openkt` {type:'stdio', command, args}
 * (macOS ~/Library/Application Support/Code/User/, Linux ~/.config/Code/User/) — https://code.visualstudio.com/docs/copilot/customization/mcp-servers
 * Copilot's agent hooks (Preview) also read ~/.claude/settings.json, so with Claude Code connected its sessions are
 * saved too; OpenKT does not write a second set of hooks for it — https://code.visualstudio.com/docs/copilot/customization/hooks
 * Only the default profile is configured (profiles live under User/profiles/<id>).
 */
export const vscode = defineFileIntegration({
  id: 'vscode',
  name: 'VS Code (Copilot)',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: false, autoRecall: false, nativeMemorySync: false },
  docs: ['https://code.visualstudio.com/docs/copilot/customization/mcp-servers', 'https://code.visualstudio.com/docs/copilot/customization/hooks'],
  detect: (env) => detectAny(env, [join(appSupport(env), 'Code', 'User'), '/Applications/Visual Studio Code.app'], 'code'),
  edits: (env) => [
    hookScriptEdit(env),
    jsonMemberEdit({
      file: join(appSupport(env), 'Code', 'User', 'mcp.json'),
      part: 'mcp',
      summary: 'the openkt MCP server, run by the hook script: no token in the file',
      path: ['servers', MCP_NAME],
      value: { type: 'stdio', ...mcpCommand(env) },
    }),
  ],
});
