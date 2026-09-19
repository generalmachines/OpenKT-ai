import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../api/hooks';
import { MockClient } from '../../api/mock';
import type { ConnectBridge, ConnectToolDto } from '../../shared/connect';
import { StaticConnection } from '../../state/connection';
import { ConnectTools } from '../onboarding/ConnectTools';
import { ConnectorsTools } from './ConnectorsTools';

const caps = (over: Partial<ConnectToolDto['capabilities']> = {}): ConnectToolDto['capabilities'] => ({ mcp: true, autoCapture: true, autoRecall: 'prompt', nativeMemorySync: false, ...over });
const tool = (id: string, name: string, over: Partial<ConnectToolDto> = {}): ConnectToolDto => ({
  id,
  name,
  kind: 'coding-agent',
  capabilities: caps(),
  detected: { installed: true, path: `/Users/me/.${id}` },
  status: 'not-connected',
  reasons: [],
  parts: {},
  guided: false,
  docs: [],
  ...over,
});

function fakeBridge(initial: ConnectToolDto[]) {
  let tools = initial;
  const set = (id: string, status: ConnectToolDto['status']) => {
    tools = tools.map((t) => (t.id === id ? { ...t, status } : t));
    return tools.find((t) => t.id === id)!;
  };
  const bridge: ConnectBridge = {
    list: vi.fn(async () => tools),
    plan: vi.fn(async (id: string) => [{ file: `/Users/me/.${id}/settings.json`, action: 'modify' as const, summary: 'hooks: SessionStart, UserPromptSubmit' }]),
    apply: vi.fn(async (id: string) => ({ changes: [{ file: `/Users/me/.${id}/settings.json`, action: 'modify' as const, summary: 'hooks' }], tool: set(id, 'connected') })),
    undo: vi.fn(async (id: string) => ({ changes: [], tool: set(id, 'not-connected') })),
    guide: vi.fn(async () => ({ openUrl: 'https://chatgpt.com/plugins', copy: 'https://mcp.openkt.ai/mcp', steps: ['one', 'two', 'three'] })),
    detectWeb: vi.fn(async () => false),
    test: vi.fn(async () => ({ ok: true, session_id: '11111111-2222-3333-4444-555555555555', context_md: '', steps: [{ event: 'session-start', ms: 300, output: '' }] })),
    folders: vi.fn(async () => [{ path: '/Users/me/code/acme', space_id: null, state: 'pending' as const }]),
    mapFolder: vi.fn(async (path: string, spaceId: string | null) => [{ path, space_id: spaceId, state: spaceId ? ('mapped' as const) : ('personal' as const) }]),
    shareSignIn: vi.fn(async () => ({ stored: 'unchanged' as const })),
  };
  (window as unknown as { openkt: { connect: ConnectBridge } }).openkt = { connect: bridge };
  return bridge;
}

function renderWith(ui: React.ReactNode) {
  const client = new MockClient();
  render(
    <StaticConnection client={client} settings={{ adapter: 'http', baseUrl: 'https://api.openkt.ai', token: 'okt_pat_app' }}>
      <ApiProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </ApiProvider>
    </StaticConnection>,
  );
}

afterEach(() => {
  delete (window as unknown as { openkt?: unknown }).openkt;
});

describe('Settings → Connectors', () => {
  let bridge: ConnectBridge;
  beforeEach(() => {
    bridge = fakeBridge([
      tool('claude-code', 'Claude Code', { capabilities: caps({ nativeMemorySync: true }), nativeMemoryNote: 'Also sync Claude Code’s own memory files.' }),
      tool('codex', 'Codex', { status: 'connected', reasons: ['Approve the OpenKT hooks once in Codex: type /hooks and trust them.'] }),
      tool('chatgpt', 'ChatGPT', { kind: 'browser', guided: true, capabilities: caps({ autoCapture: false, autoRecall: false }), detected: { installed: true } }),
      tool('gemini', 'Gemini CLI', { detected: { installed: false } }),
    ]);
  });

  it('ticks to connect with the app’s sign-in, unticks to undo, and shows capability chips', async () => {
    const user = userEvent.setup();
    renderWith(<ConnectorsTools />);
    const claude = await screen.findByRole('checkbox', { name: 'Claude Code' });
    expect(claude).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByText('Saves sessions automatically').length).toBeGreaterThan(0);
    expect(screen.getByText('Syncs its own memory')).toBeInTheDocument();
    expect(screen.getByText('Tools only')).toBeInTheDocument();
    await user.click(claude);
    expect(bridge.apply).toHaveBeenCalledWith('claude-code', { nativeMemory: true }, { server: 'https://api.openkt.ai', token: 'okt_pat_app' });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true'));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    expect(bridge.undo).toHaveBeenCalledWith('codex');
    expect(screen.queryByRole('checkbox', { name: 'Gemini CLI' })).not.toBeInTheDocument();
  });

  it('lists the exact files in "What will change" and runs a real test through the hooks', async () => {
    const user = userEvent.setup();
    renderWith(<ConnectorsTools />);
    const codexRow = (await screen.findByRole('checkbox', { name: 'Codex' })).closest('li')!;
    expect(within(codexRow).getByText(/type \/hooks and trust them/)).toBeInTheDocument();
    await user.click(within(codexRow).getByText('What will change'));
    expect(await within(codexRow).findByText(/~\/\.codex\/settings\.json/)).toBeInTheDocument();
    await user.click(within(codexRow).getByRole('button', { name: 'Test' }));
    expect(await within(codexRow).findByText(/Saved a test session through the hooks in 300 ms/)).toBeInTheDocument();
    expect(within(codexRow).getByRole('link', { name: 'Open it' })).toHaveAttribute('href', '/sessions/11111111-2222-3333-4444-555555555555');
  });

  it('a browser tool opens its steps; "I’ve done it" records it', async () => {
    const user = userEvent.setup();
    renderWith(<ConnectorsTools />);
    await user.click(await screen.findByRole('checkbox', { name: 'ChatGPT' }));
    expect(bridge.apply).not.toHaveBeenCalled();
    expect(await screen.findByText('three')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open chatgpt.com' })).toHaveAttribute('href', 'https://chatgpt.com/plugins');
    await user.click(screen.getByRole('button', { name: 'I’ve done it' }));
    expect(bridge.apply).toHaveBeenCalledWith('chatgpt', undefined, expect.anything());
  });

  it('offers to file an unknown repository in a team space', async () => {
    renderWith(<ConnectorsTools />);
    expect(await screen.findByText(/Sessions from ~\/code\/acme are private to you. File them in a team space\?/)).toBeInTheDocument();
  });
});

describe('Onboarding → Connect your tools', () => {
  it('ticks what is on this Mac, connects them in one go, then moves on', async () => {
    const user = userEvent.setup();
    const bridge = fakeBridge([tool('claude-code', 'Claude Code'), tool('codex', 'Codex'), tool('chatgpt', 'ChatGPT', { kind: 'browser', guided: true })]);
    const onDone = vi.fn();
    renderWith(<ConnectTools onDone={onDone} />);
    const button = await screen.findByRole('button', { name: 'Connect 2 tools' });
    expect(screen.getByRole('checkbox', { name: 'ChatGPT' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    expect(screen.getByRole('button', { name: 'Connect 1 tool' })).toBe(button);
    await user.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bridge.apply).toHaveBeenCalledTimes(1);
    expect(bridge.apply).toHaveBeenCalledWith('claude-code', { nativeMemory: true }, { server: 'https://api.openkt.ai', token: 'okt_pat_app' });
  });

  it('shows why a tool could not be connected and lets the person continue', async () => {
    const user = userEvent.setup();
    const bridge = fakeBridge([tool('claude-code', 'Claude Code')]);
    vi.mocked(bridge.apply).mockResolvedValueOnce({ error: { code: 'config_unreadable', message: '~/.claude/settings.json could not be read: Expected "," at line 3. OpenKT left it untouched.' } });
    const onDone = vi.fn();
    renderWith(<ConnectTools onDone={onDone} />);
    await user.click(await screen.findByRole('button', { name: 'Connect 1 tool' }));
    expect(await screen.findByText(/OpenKT left it untouched/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Continue anyway' }));
    expect(onDone).toHaveBeenCalled();
  });
});
