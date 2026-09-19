/**
 * Server requests and the token store, on behalf of the renderer.
 *
 * Why main does the fetch: the packaged renderer loads from file://, so its
 * Origin is "null" and the OpenKT server's CORS allowlist (an explicit list
 * of dashboard origins) refuses it. Requests from main carry no Origin and
 * are accepted like any CLI call. The renderer's HttpClient uses this when
 * the bridge exists and falls back to window.fetch in a browser.
 *
 * The token is encrypted with the OS keychain via safeStorage and written to
 * userData; it never touches localStorage when the bridge is present.
 */
import { app, ipcMain, net, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcChannel, NetRequest, NetResponse } from '../shared/ipc';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const KEY = /^[a-z0-9._-]{1,64}$/i;

function isNetRequest(v: unknown): v is NetRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['url'] === 'string' && /^https?:\/\//i.test(r['url']) && typeof r['method'] === 'string' && METHODS.has(r['method']);
}

async function request(req: unknown): Promise<NetResponse> {
  if (!isNetRequest(req)) throw new Error('net:request rejected: malformed request');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (typeof v === 'string') headers[k] = v;
  const res = await net.fetch(req.url, { method: req.method, headers, body: typeof req.body === 'string' ? req.body : undefined });
  return { status: res.status, body: await res.text() };
}

const secretPath = (key: string) => join(app.getPath('userData'), 'secrets', `${key}.bin`);

/** Also read by the on-device worker (src/main/worker/ipc.ts) for the signed-in token. */
export function secureGet(key: unknown): string | null {
  if (typeof key !== 'string' || !KEY.test(key) || !existsSync(secretPath(key))) return null;
  try {
    const raw = readFileSync(secretPath(key));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch {
    return null;
  }
}

function secureSet(key: unknown, value: unknown): void {
  if (typeof key !== 'string' || !KEY.test(key) || typeof value !== 'string') throw new Error('secure:set rejected');
  mkdirSync(join(app.getPath('userData'), 'secrets'), { recursive: true, mode: 0o700 });
  // Linux CI without a keyring has no encryption; the file mode is the only guard there.
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  writeFileSync(secretPath(key), data, { mode: 0o600 });
}

function secureDelete(key: unknown): void {
  if (typeof key === 'string' && KEY.test(key)) rmSync(secretPath(key), { force: true });
}

export function registerNetIpc(): void {
  ipcMain.handle('net:request' satisfies IpcChannel, (_e, req) => request(req));
  ipcMain.handle('secure:get' satisfies IpcChannel, (_e, key) => secureGet(key));
  ipcMain.handle('secure:set' satisfies IpcChannel, (_e, key, value) => secureSet(key, value));
  ipcMain.handle('secure:delete' satisfies IpcChannel, (_e, key) => secureDelete(key));
}
