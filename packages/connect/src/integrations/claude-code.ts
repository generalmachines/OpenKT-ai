import { join } from 'node:path';
import { defineFileIntegration } from '../engine.js';
import { detectAny, hookCommand, hooksEdit, hookScriptEdit, isOpenktCommand, jsonMemberEdit, MCP_NAME, mcpCommand, skillEdits } from './common.js';

/**
 * Claude Code: the deepest integration.
 * - MCP: user-scope server in ~/.claude.json `mcpServers` (the file `claude mcp add --scope user` writes; checked
 *   against Claude Code 2.1.278) — https://code.claude.com/docs/en/mcp
 * - Hooks in ~/.claude/settings.json — https://code.claude.com/docs/en/hooks
 *   SessionStart / UserPromptSubmit print `hookSpecificOutput.additionalContext`; Stop carries `last_assistant_message`;
 *   SessionEnd shares a 1.5 s budget unless a hook sets a longer `timeout`; `async: true` runs a hook in the background.
 * - Skill: ~/.claude/skills/openkt/ — https://code.claude.com/docs/en/skills
 * - Native memory: PostToolUse on Write|Edit|MultiEdit for ~/.claude/projects/<project>/memory/*.md
 *   (https://code.claude.com/docs/en/memory). UNVERIFIED in the docs: that Claude writes its memory files with those
 *   tools; the old OpenKT plugin relied on it in practice.
 * VS Code Copilot and Devin Local also run the hooks in ~/.claude/settings.json; the hook script labels those sessions
 * by client instead of calling them Claude Code.
 */
export const claudeCode = defineFileIntegration({
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'coding-agent',
  capabilities: { mcp: true, autoCapture: true, autoRecall: 'prompt', nativeMemorySync: true },
  nativeMemoryNote: 'Also sync Claude Code’s own memory files: what Claude remembers about your projects becomes context your other tools can use.',
  docs: ['https://code.claude.com/docs/en/hooks', 'https://code.claude.com/docs/en/mcp', 'https://code.claude.com/docs/en/skills', 'https://code.claude.com/docs/en/memory'],
  detect: (env) => detectAny(env, [join(env.home, '.claude'), join(env.home, '.claude.json')], 'claude'),
  edits(env, options) {
    const cmd = (event: string) => hookCommand(env, 'claude-code', event);
    const entries: Record<string, unknown[]> = {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: cmd('session-start'), timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt'), timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), async: true, timeout: 30 }] }],
      SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: cmd('session-end'), timeout: 5 }] }],
    };
    if (options.nativeMemory !== false) {
      entries['PostToolUse'] = [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: cmd('native-memory'), async: true, timeout: 30 }] }];
    }
    return [
      hookScriptEdit(env),
      jsonMemberEdit({
        file: join(env.home, '.claude.json'),
        part: 'mcp',
        summary: 'the openkt MCP server (user scope), run by the hook script: no token in the file',
        path: ['mcpServers', MCP_NAME],
        value: { type: 'stdio', ...mcpCommand(env), env: {} },
      }),
      hooksEdit({
        file: join(env.home, '.claude', 'settings.json'),
        summary:
          options.nativeMemory !== false
            ? 'hooks: SessionStart, UserPromptSubmit, Stop, SessionEnd, PostToolUse (memory files)'
            : 'hooks: SessionStart, UserPromptSubmit, Stop, SessionEnd',
        root: ['hooks'],
        entries,
        isOurs: (group) => {
          const hooks = (group as { hooks?: { command?: unknown }[] } | null)?.hooks;
          return Array.isArray(hooks) && hooks.some((h) => isOpenktCommand(h?.command));
        },
      }),
      ...skillEdits(join(env.home, '.claude', 'skills', 'openkt')),
    ];
  },
});
