/**
 * Connect tools from the app: the tick UI calls packages/connect over IPC. The same package backs `openkt-connect` and
 * `kt connect`, so the app does nothing a shell cannot. @openkt/connect is ESM and this process is CommonJS, so it is
 * loaded lazily: the packaged app ships an esbuild bundle (dist-electron/vendor/openkt-connect.cjs, built by
 * scripts/bundle-agents.mjs); dev and tests fall back to the workspace package.
 *
 * The hooks installed into each tool read the shared credentials store (macOS keychain item openkt/default, or
 * ~/.openkt/credentials.json). On apply the app stores its own sign-in there when the store has none for that server,
 * so a tick works end to end without a terminal. Writing the store on every sign-in/sign-out is the senior's follow-up
 * in src/api/auth.ts (see packages/connect/README.md, "Credentials").
 */
import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectErrorDto, ConnectSignInDto } from '../../shared/connect';
import type { IpcChannel } from '../../shared/ipc';

interface Env {
  home: string;
}
interface ConnectModule {
  systemEnv(): Env;
  listTools(env: Env): Promise<unknown[]>;
  planTool(env: Env, id: string, options?: { nativeMemory?: boolean }): Promise<unknown[]>;
  connectTool(env: Env, id: string, options?: { nativeMemory?: boolean }, force?: boolean): Promise<unknown>;
  disconnectTool(env: Env, id: string): Promise<unknown>;
  guideTool(env: Env, id: string): Promise<unknown>;
  getIntegration(id: string): { detectConnection?: (env: Env, since: Date) => Promise<boolean> };
  selfTest(env: Env, tool?: string): Promise<unknown>;
  listFolders(env: Env): unknown[];
  mapFolder(env: Env, path: string, spaceId: string | null, spaceName?: string): void;
  readCredentials(env: Env): Promise<{ server: string; token: string | null; source: string }>;
  writeCredentials(env: Env, creds: { server: string; token: string }): Promise<'keychain' | 'file'>;
}

const CONNECT_PACKAGE: string = '@openkt/connect';
let cached: Promise<ConnectModule> | null = null;
export function loadConnect(): Promise<ConnectModule> {
  if (!cached) {
    const bundled = join(__dirname, '..', '..', 'vendor', 'openkt-connect.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = existsSync(bundled) ? Promise.resolve(require(bundled) as ConnectModule) : (import(CONNECT_PACKAGE) as Promise<ConnectModule>);
  }
  return cached;
}

function asError(err: unknown): ConnectErrorDto {
  const e = err as { code?: unknown; message?: unknown; hint?: unknown; file?: unknown };
  return {
    error: {
      code: typeof e?.code === 'string' ? e.code : 'internal',
      message: typeof e?.message === 'string' ? e.message : String(err),
      ...(typeof e?.hint === 'string' ? { hint: e.hint } : {}),
      ...(typeof e?.file === 'string' ? { file: e.file } : {}),
    },
  };
}

const TOOL_ID = /^[a-z0-9-]{1,40}$/;

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !TOOL_ID.test(id)) throw Object.assign(new Error('unknown tool'), { code: 'unknown_tool' });
  return id;
}

function validSignIn(v: unknown): ConnectSignInDto | null {
  const s = v as Partial<ConnectSignInDto> | null;
  if (!s || typeof s.server !== 'string' || typeof s.token !== 'string') return null;
  if (!/^https?:\/\/[^\s]+$/.test(s.server) || !/^okt_pat_[A-Za-z0-9]+$/.test(s.token)) return null;
  return { server: s.server.replace(/\/+$/, ''), token: s.token };
}

/** Store the app's sign-in for the hooks unless the store already holds exactly it (or the environment overrides). */
export async function shareSignIn(c: ConnectModule, env: Env, signIn: unknown): Promise<'keychain' | 'file' | 'unchanged'> {
  const s = validSignIn(signIn);
  if (!s) return 'unchanged';
  const current = await c.readCredentials(env);
  if (current.source === 'env' || (current.token === s.token && current.server === s.server)) return 'unchanged';
  return c.writeCredentials(env, s);
}

export function registerConnectIpc(): void {
  const handle = (channel: IpcChannel, fn: (c: ConnectModule, env: Env, ...args: unknown[]) => Promise<unknown> | unknown) =>
    ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
      try {
        const c = await loadConnect();
        return await fn(c, c.systemEnv(), ...args);
      } catch (err) {
        return asError(err);
      }
    });
  const opts = (v: unknown) => ({ nativeMemory: (v as { nativeMemory?: unknown } | undefined)?.nativeMemory !== false });

  handle('connect:list', (c, env) => c.listTools(env));
  handle('connect:plan', (c, env, id, o) => c.planTool(env, checkId(id), opts(o)));
  handle('connect:apply', async (c, env, id, o, signIn) => {
    await shareSignIn(c, env, signIn);
    return c.connectTool(env, checkId(id), opts(o));
  });
  handle('connect:undo', (c, env, id) => c.disconnectTool(env, checkId(id)));
  handle('connect:guide', (c, env, id) => c.guideTool(env, checkId(id)));
  handle('connect:detect-web', async (c, env, id, since) => {
    const integration = c.getIntegration(checkId(id));
    const when = new Date(typeof since === 'string' ? since : 0);
    return integration.detectConnection ? integration.detectConnection(env, Number.isNaN(when.getTime()) ? new Date(0) : when) : false;
  });
  handle('connect:test', (c, env, id) => c.selfTest(env, checkId(id)));
  handle('connect:folders', (c, env) => c.listFolders(env));
  handle('connect:map-folder', (c, env, path, spaceId, spaceName) => {
    if (typeof path !== 'string' || !path.startsWith('/')) throw Object.assign(new Error('a folder is an absolute path'), { code: 'invalid' });
    c.mapFolder(env, path, typeof spaceId === 'string' && spaceId ? spaceId : null, typeof spaceName === 'string' ? spaceName : undefined);
    return c.listFolders(env);
  });
  handle('connect:share-sign-in', async (c, env, signIn) => ({ stored: await shareSignIn(c, env, signIn) }));
}
