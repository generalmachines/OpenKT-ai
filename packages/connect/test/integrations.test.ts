import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectTool, disconnectTool, listTools, planTool } from '../src/api.js';
import { homeEnv } from '../src/env.js';
import { ConnectError } from '../src/errors.js';
import { parseJsonc } from '../src/jsonc.js';
import { getIntegration } from '../src/registry.js';
import type { ConnectEnv } from '../src/types.js';

let home: string;
let env: ConnectEnv;
const at = (rel: string) => join(home, rel);
const read = (rel: string) => readFileSync(at(rel), 'utf8');
function put(rel: string, content: string) {
  mkdirSync(dirname(at(rel)), { recursive: true });
  writeFileSync(at(rel), content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'okt-int-'));
  env = homeEnv(home, { platform: 'darwin', now: () => new Date('2026-09-19T12:00:00Z') });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const APP = 'Library/Application Support';

interface Case {
  id: string;
  /** Makes the tool look installed. */
  install: () => void;
  /** The config file with unrelated content that must survive, and a line from it to look for. */
  config: string;
  existing: string;
  malformed: string;
  /** A path inside the config that must hold OpenKT's MCP entry after apply (JSON configs). */
  mcpPath?: string[];
}

const CASES: Case[] = [
  {
    id: 'claude-code',
    install: () => mkdirSync(at('.claude'), { recursive: true }),
    config: '.claude/settings.json',
    existing: '{\n  // comments survive\n  "model": "opus",\n  "hooks": {\n    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo hi" }] }]\n  },\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n',
    malformed: '{ "model": "opus", ',
  },
  {
    id: 'codex',
    install: () => mkdirSync(at('.codex'), { recursive: true }),
    config: '.codex/config.toml',
    existing: 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n\n[profiles.fast]\nmodel = "o4-mini"\n',
    malformed: 'model = "gpt-5"\n[mcp_servers]\nopenkt = { url = "https://x" }\n',
  },
  {
    id: 'cursor',
    install: () => mkdirSync(at('.cursor'), { recursive: true }),
    config: '.cursor/mcp.json',
    existing: '{\n    "mcpServers": {\n        "github": { "url": "https://api.githubcopilot.com/mcp/" }\n    }\n}\n',
    malformed: '{"mcpServers": {"github": }',
    mcpPath: ['mcpServers', 'openkt'],
  },
  {
    id: 'gemini',
    install: () => mkdirSync(at('.gemini'), { recursive: true }),
    config: '.gemini/settings.json',
    existing: '{\n  "theme": "GitHub",\n  "mcpServers": {},\n  "hooks": { "BeforeTool": [ { "matcher": "run_shell_command", "hooks": [ { "name": "audit", "type": "command", "command": "./audit.sh" } ] } ] }\n}\n',
    malformed: '{"theme": "GitHub",,}',
    mcpPath: ['mcpServers', 'openkt'],
  },
  {
    id: 'vscode',
    install: () => mkdirSync(at(`${APP}/Code/User`), { recursive: true }),
    config: `${APP}/Code/User/mcp.json`,
    existing: '{\n\t"servers": {\n\t\t"fetch": { "type": "stdio", "command": "uvx", "args": ["mcp-server-fetch"] }\n\t},\n\t"inputs": []\n}\n',
    malformed: '{\n\t"servers": [\n}',
    mcpPath: ['servers', 'openkt'],
  },
  {
    id: 'opencode',
    install: () => mkdirSync(at('.config/opencode'), { recursive: true }),
    config: '.config/opencode/opencode.json',
    existing: '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "tokyonight"\n}\n',
    malformed: 'not json at all',
    mcpPath: ['mcp', 'openkt'],
  },
  {
    id: 'windsurf',
    install: () => mkdirSync(at('.codeium/windsurf'), { recursive: true }),
    config: '.codeium/windsurf/mcp_config.json',
    existing: '{"mcpServers":{"figma":{"serverUrl":"https://mcp.figma.com/mcp"}}}',
    malformed: '{"mcpServers":{"figma":{"serverUrl":}}}',
    mcpPath: ['mcpServers', 'openkt'],
  },
  {
    id: 'claude-desktop',
    install: () => mkdirSync(at(`${APP}/Claude`), { recursive: true }),
    config: `${APP}/Claude/claude_desktop_config.json`,
    existing: '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"] }\n  },\n  "globalShortcut": "Alt+Space"\n}\n',
    malformed: '{"mcpServers": {',
    mcpPath: ['mcpServers', 'openkt'],
  },
];

describe.each(CASES)('$id', (c) => {
  it('connects into an empty home, is idempotent, and undoes cleanly', async () => {
    c.install();
    const { changes, tool } = await connectTool(env, c.id);
    expect(changes.length).toBeGreaterThan(0);
    expect(tool.status).toBe('connected');
    expect(existsSync(at('.openkt/hooks/openkt-hook.sh'))).toBe(true);
    expect(statSync(at('.openkt/hooks/openkt-hook.sh')).mode & 0o777).toBe(0o755);
    const text = read(c.config);
    expect(text).not.toMatch(/okt_pat_|Bearer/);
    if (c.mcpPath) expect(JSON.stringify(parseJsonc(text))).toContain('openkt-hook.sh');
    expect(await planTool(env, c.id)).toEqual([]);
    expect((await connectTool(env, c.id)).changes).toEqual([]);
    await disconnectTool(env, c.id);
    expect(existsSync(at(c.config))).toBe(false);
    expect(existsSync(at('.openkt/hooks/openkt-hook.sh'))).toBe(false);
    expect((await listTools(env)).find((t) => t.id === c.id)?.status).toBe('not-connected');
  });

  it('keeps unrelated settings byte for byte and undo restores the original exactly', async () => {
    c.install();
    put(c.config, c.existing);
    await connectTool(env, c.id);
    const after = read(c.config);
    // Everything that was there is still there, in the same bytes, before OpenKT's addition.
    const firstChange = [...c.existing].findIndex((ch, i) => after[i] !== ch);
    const untouchedPrefix = c.existing.slice(0, firstChange < 0 ? c.existing.length : firstChange);
    expect(after.startsWith(untouchedPrefix)).toBe(true);
    // Lines that hold the objects OpenKT adds to (the MCP server list, the hooks map) may gain a member; every other
    // line is unchanged.
    const touched = (l: string) => (c.mcpPath && l.includes(`"${c.mcpPath[0]}"`)) || l.includes('"hooks"');
    for (const line of c.existing.split('\n').filter((l) => l.trim().length > 3 && !/^[\s{}[\],]*$/.test(l) && !touched(l))) {
      expect(after).toContain(line.replace(/,$/, ''));
    }
    if (c.mcpPath) expect((parseJsonc(after) as Record<string, Record<string, unknown>>)[c.mcpPath[0]!]?.[c.mcpPath[1]!]).toBeTruthy();
    await disconnectTool(env, c.id);
    expect(read(c.config)).toBe(c.existing);
  });

  it('leaves a config it cannot read untouched and reports needs-attention', async () => {
    c.install();
    put(c.config, c.malformed);
    const err = await connectTool(env, c.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(['config_unreadable', 'conflict']).toContain((err as ConnectError).code);
    expect(read(c.config)).toBe(c.malformed);
    expect(existsSync(at('.openkt/hooks/openkt-hook.sh'))).toBe(false);
    const status = await getIntegration(c.id).status(env);
    expect(status.status).toBe('needs-attention');
    expect(status.reasons.join(' ')).toMatch(/could not be read|inline/);
  });
});

describe('claude-code specifics', () => {
  beforeEach(() => mkdirSync(at('.claude'), { recursive: true }));

  it('installs MCP (stdio, no token), five hooks, the skill; native memory can be switched off', async () => {
    await connectTool(env, 'claude-code');
    const claudeJson = JSON.parse(read('.claude.json')) as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
    expect(claudeJson.mcpServers['openkt']).toEqual({ type: 'stdio', command: '/bin/sh', args: [at('.openkt/hooks/openkt-hook.sh'), 'mcp'], env: {} });
    const settings = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, { matcher?: string; hooks: { command: string; async?: boolean }[] }[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(settings.hooks['UserPromptSubmit']![0]!.hooks[0]!.command).toBe(`/bin/sh ${at('.openkt/hooks/openkt-hook.sh')} claude-code prompt`);
    expect(settings.hooks['Stop']![0]!.hooks[0]!.async).toBe(true);
    expect(settings.hooks['PostToolUse']![0]!.matcher).toBe('Write|Edit|MultiEdit');
    expect(read('.claude/skills/openkt/SKILL.md')).toMatch(/^---\nname: openkt/);

    const { tool } = await connectTool(env, 'claude-code', { nativeMemory: false });
    expect(tool.status).toBe('connected');
    const again = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, unknown> };
    expect(Object.keys(again.hooks)).not.toContain('PostToolUse');
  });

  it('replaces hooks left by the old kt CLI and keeps the person’s own hooks', async () => {
    put(
      '.claude/settings.json',
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'kt prime' }] }],
            UserPromptSubmit: [
              { matcher: '*', hooks: [{ type: 'command', command: `python3 ${home}/.openkt/hooks/recall.py` }] },
              { matcher: '', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
            ],
          },
        },
        null,
        2,
      ),
    );
    await connectTool(env, 'claude-code');
    const s = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const commands = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('my-own-hook.sh');
    expect(commands.some((c) => c === 'kt prime' || c.includes('recall.py'))).toBe(false);
    expect(commands.filter((c) => c.includes('openkt-hook.sh'))).toHaveLength(5);
  });

  it('undo after the person edited the file removes only OpenKT’s entries', async () => {
    put('.claude/settings.json', '{\n  "model": "opus"\n}\n');
    await connectTool(env, 'claude-code');
    const edited = read('.claude/settings.json').replace('"model": "opus"', '"model": "sonnet"');
    writeFileSync(at('.claude/settings.json'), edited);
    await disconnectTool(env, 'claude-code');
    expect(JSON.parse(read('.claude/settings.json'))).toEqual({ model: 'sonnet' });
  });

  it('keeps the shared hook script while another tool still uses it', async () => {
    mkdirSync(at('.codex'), { recursive: true });
    await connectTool(env, 'claude-code');
    await connectTool(env, 'codex');
    await disconnectTool(env, 'claude-code');
    expect(existsSync(at('.openkt/hooks/openkt-hook.sh'))).toBe(true);
    expect((await getIntegration('codex').status(env)).status).toBe('connected');
    await disconnectTool(env, 'codex');
    expect(existsSync(at('.openkt/hooks/openkt-hook.sh'))).toBe(false);
  });

  it('a tool whose only present part is the shared script reads as not connected', async () => {
    mkdirSync(at('.cursor'), { recursive: true });
    await connectTool(env, 'claude-code');
    expect((await getIntegration('cursor').status(env)).status).toBe('not-connected');
  });

  it('backs up the original next to it before the first write', async () => {
    put('.claude/settings.json', '{"model":"opus"}\n');
    await connectTool(env, 'claude-code');
    expect(read('.claude/settings.json.openkt-backup-20260919-120000')).toBe('{"model":"opus"}\n');
  });

  it('refuses a tool that is not installed unless forced', async () => {
    rmSync(at('.claude'), { recursive: true });
    await expect(connectTool(env, 'claude-code')).rejects.toMatchObject({ code: 'not_installed' });
    expect((await connectTool(env, 'claude-code', {}, true)).tool.status).toBe('connected');
  });
});

describe('codex specifics', () => {
  beforeEach(() => mkdirSync(at('.codex'), { recursive: true }));

  it('writes a marked [mcp_servers.openkt] block and hooks.json, replacing the old kt CLI table', async () => {
    put('.codex/config.toml', 'model = "gpt-5"\n\n[mcp_servers.openkt]\nurl = "https://api.openkt.ai/mcp"\nbearer_token_env_var = "OPENKT_TOKEN"\n\n[profiles.fast]\nmodel = "o4-mini"\n');
    const { tool } = await connectTool(env, 'codex');
    const toml = read('.codex/config.toml');
    expect(toml).not.toContain('bearer_token_env_var');
    expect(toml.match(/\[mcp_servers\.openkt\]/g)).toHaveLength(1);
    expect(toml).toContain('[profiles.fast]\nmodel = "o4-mini"');
    expect(toml).toContain(`args = ["${at('.openkt/hooks/openkt-hook.sh')}", "mcp"]`);
    const hooks = JSON.parse(read('.codex/hooks.json')) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(tool.reasons.join(' ')).toMatch(/\/hooks/);
  });
});

describe('cursor specifics', () => {
  it('writes hooks.json with version 1 and the four events', async () => {
    mkdirSync(at('.cursor'), { recursive: true });
    await connectTool(env, 'cursor');
    const hooks = JSON.parse(read('.cursor/hooks.json')) as { version: number; hooks: Record<string, { command: string }[]> };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual(['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'sessionEnd']);
    expect(hooks.hooks['beforeSubmitPrompt']![0]!.command).toContain('cursor prompt');
  });
});

describe('guided tools', () => {
  it('claude.ai and ChatGPT are ticked by hand and never touch a file', async () => {
    const before = await listTools(env);
    expect(before.find((t) => t.id === 'chatgpt')).toMatchObject({ guided: true, status: 'not-connected' });
    await connectTool(env, 'chatgpt');
    expect((await getIntegration('chatgpt').status(env)).status).toBe('connected');
    await disconnectTool(env, 'chatgpt');
    expect((await getIntegration('chatgpt').status(env)).status).toBe('not-connected');
  });

  it('lists detected coding tools first', async () => {
    mkdirSync(at('.codex'), { recursive: true });
    const tools = await listTools(env);
    expect(tools[0]!.id).toBe('codex');
  });
});
