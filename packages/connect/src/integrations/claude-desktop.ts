import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { appSupport } from '../env.js';
import { detectAny, hookScriptEdit, jsonMemberEdit, MCP_NAME, mcpCommand } from './common.js';

/**
 * Claude Desktop: a local stdio server in claude_desktop_config.json `mcpServers.openkt` {command, args} —
 * https://modelcontextprotocol.io/docs/develop/connect-local-servers . Remote servers go through Settings → Connectors
 * and are reached from Anthropic's cloud (https://support.claude.com/en/articles/11175166), which needs the server's
 * OAuth sign-in; the local command needs neither OAuth nor Node: the hook script forwards over curl. Restart Claude
 * after connecting. No hooks exist in Claude Desktop.
 */
export const claudeDesktop = defineFileIntegration({
  id: 'claude-desktop',
  name: 'Claude Desktop',
  kind: 'desktop-app',
  capabilities: { mcp: true, autoCapture: false, autoRecall: false, nativeMemorySync: false },
  docs: ['https://modelcontextprotocol.io/docs/develop/connect-local-servers', 'https://support.claude.com/en/articles/11175166'],
  detect: (env) => detectAny(env, [join(appSupport(env), 'Claude'), '/Applications/Claude.app']),
  afterApply: ['Quit and reopen Claude Desktop to load the OpenKT tools.'],
  edits: (env) => [
    hookScriptEdit(env),
    jsonMemberEdit({
      file: join(appSupport(env), 'Claude', 'claude_desktop_config.json'),
      part: 'mcp',
      summary: 'the openkt MCP server, run by the hook script: no token in the file',
      path: ['mcpServers', MCP_NAME],
      value: mcpCommand(env),
    }),
  ],
});
