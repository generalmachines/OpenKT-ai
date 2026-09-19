/**
 * `auth:google:start` / `auth:google:cancel` for the renderer's Welcome screen.
 * Errors cross IPC as plain messages, so the result is a tagged value instead:
 * `{ id_token }` or `{ error: 'cancelled' | 'timeout' | 'failed', message }`.
 */
import { ipcMain, net, shell } from 'electron';
import type { GoogleAuthResultDto, IpcChannel } from '../../shared/ipc';
import { signInWithGoogle } from './google';
import { AuthFlowError } from './loopback';

let inFlight: AbortController | null = null;

async function start(input: unknown, onDone?: () => void): Promise<GoogleAuthResultDto> {
  const j = (input ?? {}) as { clientId?: unknown; clientSecret?: unknown };
  if (typeof j.clientId !== 'string' || !j.clientId.trim()) return { error: 'failed', message: 'no Google client id' };
  inFlight?.abort(); // a second click replaces the first attempt
  const controller = (inFlight = new AbortController());
  try {
    return await signInWithGoogle(
      { clientId: j.clientId, clientSecret: typeof j.clientSecret === 'string' && j.clientSecret ? j.clientSecret : undefined },
      { openExternal: (url) => shell.openExternal(url), fetch: (url, init) => net.fetch(url as string, init as RequestInit), signal: controller.signal },
    );
  } catch (e) {
    return e instanceof AuthFlowError ? { error: e.kind, message: e.message } : { error: 'failed', message: 'sign-in failed' };
  } finally {
    if (inFlight === controller) inFlight = null;
    onDone?.();
  }
}

/** `focusApp` brings the main window back to the front once the browser part is over. */
export function registerAuthIpc(focusApp?: () => void): void {
  ipcMain.handle('auth:google:start' satisfies IpcChannel, (_e, input) => start(input, focusApp));
  ipcMain.handle('auth:google:cancel' satisfies IpcChannel, () => void inFlight?.abort());
}
