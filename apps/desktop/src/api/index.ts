import type { OpenKTClient } from './client';
import { HttpClient } from './http';
import { MockClient } from './mock';

export type { OpenKTClient } from './client';
export * from './types';

export interface ApiSettings {
  adapter: 'mock' | 'http';
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = 'openkt.api';

export const DEFAULT_API_SETTINGS: ApiSettings = { adapter: 'mock', baseUrl: 'http://localhost:3000', token: '' };

function fromEnv(): Partial<ApiSettings> {
  const env = import.meta.env;
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

/** Order: defaults ← build-time env ← what the user saved in Settings → Workspace. */
export function loadApiSettings(): ApiSettings {
  return { ...DEFAULT_API_SETTINGS, ...fromEnv(), ...fromStorage() };
}

export function saveApiSettings(s: ApiSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private window: the choice simply does not persist */
  }
}

export function createClient(settings: ApiSettings = loadApiSettings()): OpenKTClient {
  if (settings.adapter === 'http' && settings.baseUrl) {
    return new HttpClient({ baseUrl: settings.baseUrl, token: settings.token });
  }
  return new MockClient();
}
