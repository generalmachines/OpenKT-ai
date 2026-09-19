import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectBridge, ConnectChangeDto, ConnectErrorDto, ConnectFolderDto, ConnectGuideDto, ConnectSignInDto, ConnectTestDto, ConnectToolDto } from '../../shared/connect';
import { isConnectError } from '../../shared/connect';
import { useConnection } from '../../state/connection';

/**
 * The renderer's side of "Connect your tools" (packages/connect through window.openkt.connect). Same rule as the other
 * bridges: in a browser (vite dev, tests without a fake bridge) it is simply not available and the screens say so.
 */
export function connectBridge(): ConnectBridge | null {
  if (typeof window === 'undefined') return null;
  const c = (window.openkt as { connect?: ConnectBridge } | undefined)?.connect;
  return c && typeof c.list === 'function' ? c : null;
}

export class ConnectFailure extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(e: ConnectErrorDto['error']) {
    super(e.message);
    this.code = e.code;
    this.hint = e.hint;
  }
}

function unwrap<T>(v: T | ConnectErrorDto): T {
  if (isConnectError(v)) throw new ConnectFailure(v.error);
  return v;
}

/** The app's sign-in, for the hooks: only a real server session, never the sample account. */
export function useSignIn(): ConnectSignInDto | undefined {
  const { settings } = useConnection();
  return settings.adapter === 'http' && settings.token && settings.baseUrl ? { server: settings.baseUrl, token: settings.token } : undefined;
}

export function capabilityChips(t: Pick<ConnectToolDto, 'capabilities' | 'kind'>): string[] {
  const c = t.capabilities;
  const chips: string[] = [];
  if (c.autoCapture) chips.push('Saves sessions automatically');
  if (c.autoRecall === 'prompt') chips.push('Brings context into prompts');
  if (c.autoRecall === 'session-start') chips.push('Brings context when a chat starts');
  if (c.nativeMemorySync) chips.push('Syncs its own memory');
  if (chips.length === 0 && c.mcp) chips.push('Tools only');
  return chips;
}

export function foundLabel(t: ConnectToolDto, home?: string): string {
  if (t.kind === 'browser') return 'set up in your browser';
  if (t.kind === 'agent') return 'any agent with a shell';
  if (!t.detected.installed) return 'not found on this Mac';
  const path = t.detected.path ?? '';
  const short = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path.replace(/^\/Users\/[^/]+/, '~');
  return short ? `found · ${short}` : 'found';
}

export const STATUS_LABEL: Record<ConnectToolDto['status'], string> = {
  connected: 'connected',
  partial: 'partly connected',
  'not-connected': 'not connected',
  'needs-attention': 'needs attention',
};

export interface ToolsState {
  available: boolean;
  tools: ConnectToolDto[] | null;
  error: Error | null;
  busy: Record<string, boolean>;
  results: Record<string, { ok: boolean; message: string; changes?: ConnectChangeDto[] }>;
  refresh(): Promise<void>;
  apply(id: string, options?: { nativeMemory?: boolean }): Promise<boolean>;
  undo(id: string): Promise<boolean>;
  plan(id: string, options?: { nativeMemory?: boolean }): Promise<ConnectChangeDto[]>;
  guide(id: string): Promise<ConnectGuideDto | null>;
  test(id: string): Promise<ConnectTestDto>;
}

export function useTools(): ToolsState {
  const bridge = connectBridge();
  const signIn = useSignIn();
  const [tools, setTools] = useState<ConnectToolDto[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<ToolsState['results']>({});
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const list = unwrap(await bridge.list());
      if (live.current) {
        setTools(list);
        setError(null);
      }
    } catch (err) {
      if (live.current) setError(err as Error);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (id: string, fn: () => Promise<{ changes: ConnectChangeDto[]; tool: ConnectToolDto } | ConnectErrorDto>, verb: string): Promise<boolean> => {
      setBusy((b) => ({ ...b, [id]: true }));
      try {
        const r = unwrap(await fn());
        setTools((list) => (list ? list.map((t) => (t.id === id ? r.tool : t)) : list));
        setResults((m) => ({ ...m, [id]: { ok: true, message: r.changes.length ? `${verb}: ${r.changes.length} ${r.changes.length === 1 ? 'file' : 'files'} changed` : `${verb}: nothing to change`, changes: r.changes } }));
        return true;
      } catch (err) {
        const e = err as ConnectFailure;
        setResults((m) => ({ ...m, [id]: { ok: false, message: e.hint ? `${e.message} (${e.hint})` : e.message } }));
        await refresh();
        return false;
      } finally {
        setBusy((b) => ({ ...b, [id]: false }));
      }
    },
    [refresh],
  );

  return {
    available: bridge !== null,
    tools,
    error,
    busy,
    results,
    refresh,
    apply: (id, options) => (bridge ? run(id, () => bridge.apply(id, options, signIn), 'Connected') : Promise.resolve(false)),
    undo: (id) => (bridge ? run(id, () => bridge.undo(id), 'Disconnected') : Promise.resolve(false)),
    plan: async (id, options) => (bridge ? unwrap(await bridge.plan(id, options)) : []),
    guide: async (id) => (bridge ? unwrap(await bridge.guide(id)) : null),
    test: async (id) => {
      if (!bridge) throw new Error('Testing needs the OpenKT app.');
      return unwrap(await bridge.test(id));
    },
  };
}

/** How many AI tools are connected on this Mac (the session footer's "retrievable from N connected tools"). */
export function useConnectedToolCount(): number | null {
  const bridge = connectBridge();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.list().then((r) => {
      if (live && !isConnectError(r)) setCount(r.filter((t) => t.status === 'connected' && t.kind !== 'agent').length);
    });
    return () => void (live = false);
  }, [bridge]);
  return count;
}

export function useFolders() {
  const bridge = connectBridge();
  const [folders, setFolders] = useState<ConnectFolderDto[]>([]);
  useEffect(() => {
    if (!bridge) return;
    void bridge.folders().then((r) => !isConnectError(r) && setFolders(r));
  }, [bridge]);
  const map = useCallback(
    async (path: string, spaceId: string | null, spaceName?: string) => {
      if (!bridge) return;
      const r = await bridge.mapFolder(path, spaceId, spaceName);
      if (!isConnectError(r)) setFolders(r);
    },
    [bridge],
  );
  return { folders, map };
}
