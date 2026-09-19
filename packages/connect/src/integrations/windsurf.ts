import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { detectAny, hookCommand, hooksEdit, hookScriptEdit, isOpenktCommand, jsonMemberEdit, MCP_NAME, mcpCommand } from './common.js';

/**
 * Windsurf (Cascade), now part of Devin Desktop.
 * - MCP: ~/.codeium/windsurf/mcp_config.json `mcpServers.openkt` {command, args} — https://docs.devin.ai/desktop/cascade/mcp
 * - Hooks: ~/.codeium/windsurf/hooks.json; pre_user_prompt (tool_info.user_prompt) and post_cascade_response
 *   (tool_info.response) keyed by trajectory_id. Cascade hooks cannot add context, so prompts and replies are saved
 *   but recall stays with the MCP tools — https://docs.devin.ai/desktop/cascade/hooks
 * Devin Local (the newer agent) reads ~/.claude/settings.json hooks and its own ~/.config/devin/config.json; it is
 * not configured here.
 */
export const windsurf = defineFileIntegration({
  id: 'windsurf',
  name: 'Windsurf',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: true, autoRecall: false, nativeMemorySync: false },
  docs: ['https://docs.devin.ai/desktop/cascade/mcp', 'https://docs.devin.ai/desktop/cascade/hooks'],
  detect: (env) => detectAny(env, [join(env.home, '.codeium', 'windsurf'), '/Applications/Windsurf.app'], 'windsurf'),
  edits(env) {
    const hook = (event: string) => ({ command: hookCommand(env, 'windsurf', event), show_output: false });
    return [
      hookScriptEdit(env),
      jsonMemberEdit({
        file: join(env.home, '.codeium', 'windsurf', 'mcp_config.json'),
        part: 'mcp',
        summary: 'the openkt MCP server, run by the hook script: no token in the file',
        path: ['mcpServers', MCP_NAME],
        value: mcpCommand(env),
      }),
      hooksEdit({
        file: join(env.home, '.codeium', 'windsurf', 'hooks.json'),
        summary: 'hooks: pre_user_prompt, post_cascade_response',
        root: ['hooks'],
        entries: { pre_user_prompt: [hook('prompt')], post_cascade_response: [hook('stop')] },
        isOurs: (entry) => isOpenktCommand((entry as { command?: unknown } | null)?.command),
      }),
    ];
  },
});
