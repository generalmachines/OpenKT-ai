import { secureStore } from './bridge';
import type { OpenKTClient } from './client';
import { DEFAULT_SERVER_URL } from './config';
import { HttpClient } from './http';
import { MockClient } from './mock';

export type { OpenKTClient } from './client';
export { DEFAULT_SERVER_URL, TOKEN_PREFIX } from './config';
export { ApiError, describeError, isUnauthorized } from './errors';
export * from './types';

export interface ApiSettings {
  adapter: 'mock' | 'http';
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = 'openkt.api';
const TOKEN_KEY = 'server-token';

export const DEFAULT_API_SETTINGS: ApiSettings = {
  adapter: 'mock',
  baseUrl: DEFAULT_SERVER_URL,
  token: '',
};

function fromEnv(): Partial<ApiSettings> {
  const env = import.meta.env ?? {};
  const out: Partial<ApiSettings> = {};
  if (env.VITE_OPENKT_API === 'http' || env.VITE_OPENKT_API === 'mock') out.adapter = env.VITE_OPENKT_API;
  if (env.VITE_OPENKT_BASE_URL) out.baseUrl = env.VITE_OPENKT_BASE_URL;
  if (env.VITE_OPENKT_TOKEN) out.token = env.VITE_OPENKT_TOKEN;
  return out;
}

function fromStorage(): Partial<ApiSettings> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<ApiSettings>) : {};
  } catch {
    return {};
  }
}

/** True until the person has chosen a server or sample data once. */
export function isFirstRun(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) == null;
  } catch {
    return false;
  }
}

/**
 * Order: defaults ← build-time env ← what the person saved. The token comes
 * from the OS keychain when the Electron bridge offers one.
 */
export async function loadApiSettings(): Promise<ApiSettings> {
  const s = { ...DEFAULT_API_SETTINGS, ...fromEnv(), ...fromStorage() };
  if (secureStore.available()) s.token = (await secureStore.get(TOKEN_KEY).catch(() => null)) ?? s.token;
  return s;
}

export async function saveApiSettings(s: ApiSettings): Promise<void> {
  const secure = secureStore.available();
  if (secure) await (s.token ? secureStore.set(TOKEN_KEY, s.token) : secureStore.delete(TOKEN_KEY));
  try {
    // TODO(secure-store): in a plain browser (vite dev) there is no keychain, so the token sits in localStorage.
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(secure ? { adapter: s.adapter, baseUrl: s.baseUrl } : s));
  } catch {
    /* private window: the choice simply does not persist */
  }
}

/** Forget the token, keep the server address, and land on the Connect screen. */
export async function signOut(): Promise<void> {
  const s = await loadApiSettings();
  await saveApiSettings({ ...s, adapter: 'http', token: '' });
}

export function createClient(settings: ApiSettings, onUnauthorized?: () => void): OpenKTClient {
  if (settings.adapter === 'http' && settings.baseUrl) {
    return new HttpClient({
      baseUrl: settings.baseUrl,
      token: settings.token,
      onUnauthorized,
    });
  }
  return new MockClient();
}

/** What the app should show before anything else. */
export function needsConnect(settings: ApiSettings, inElectron: boolean): boolean {
  if (settings.adapter === 'http') return !settings.token || !settings.baseUrl;
  return inElectron && isFirstRun();
}
