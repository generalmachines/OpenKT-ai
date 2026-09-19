import { HttpAuth, MockAuth, type AuthApi } from './auth';
import { secureStore } from './bridge';
import type { OpenKTClient } from './client';
import { DEFAULT_SERVER_URL, RETIRED_DEFAULT_SERVER_URLS } from './config';
import { HttpClient } from './http';
import { MockClient } from './mock';

export type { AuthApi, AuthProviders, AuthSession } from './auth';
export { describeAuthError } from './auth';
export type { OpenKTClient } from './client';
export { DEFAULT_SERVER_URL, HOSTED_SERVER_URL, MIN_PASSWORD_LENGTH, TOKEN_PREFIX } from './config';
export { ApiError, describeError, isUnauthorized } from './errors';
export * from './types';

export interface ApiSettings {
  adapter: 'mock' | 'http';
  /** The server this app signs in to. `DEFAULT_SERVER_URL` unless the person chose their own. */
  baseUrl: string;
  token: string;
  /** Who signed in here last. Prefills the form after signing out or when the session ends. Not a secret. */
  email?: string;
  /** Sample data only: the person signed out of the sample account. (With a server, "signed out" is simply "no token".) */
  signedOut?: boolean;
}

const STORAGE_KEY = 'openkt.api';
const TOKEN_KEY = 'server-token';
const ONBOARDED_KEY = 'openkt.onboarded';

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

const inElectron = (): boolean => typeof window !== 'undefined' && Boolean(window.openkt);

/**
 * Order: defaults ← build-time env ← what the person saved. The installed app
 * starts signed out against the hosted service; a plain browser (vite dev, the
 * screenshot run) starts in sample data. The token comes from the OS keychain
 * when the Electron bridge offers one.
 */
export async function loadApiSettings(): Promise<ApiSettings> {
  const s: ApiSettings = { ...DEFAULT_API_SETTINGS, ...(inElectron() ? { adapter: 'http' as const } : {}), ...fromEnv(), ...fromStorage() };
  if (!s.baseUrl || RETIRED_DEFAULT_SERVER_URLS.includes(s.baseUrl.replace(/\/+$/, ''))) s.baseUrl = DEFAULT_SERVER_URL;
  if (secureStore.available()) s.token = (await secureStore.get(TOKEN_KEY).catch(() => null)) ?? s.token;
  return s;
}

export async function saveApiSettings(s: ApiSettings): Promise<void> {
  const secure = secureStore.available();
  if (secure) await (s.token ? secureStore.set(TOKEN_KEY, s.token) : secureStore.delete(TOKEN_KEY));
  try {
    // TODO(secure-store): in a plain browser (vite dev) there is no keychain, so the token sits in localStorage.
    const { token: _token, ...rest } = s;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(secure ? rest : s));
  } catch {
    /* private window: the choice simply does not persist */
  }
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

/**
 * Who answers the sign-in form. The installed app always signs in for real —
 * even when it is showing sample data; only a plain browser in sample mode
 * (screenshots, tests, vite dev) gets the stand-in that accepts anyone.
 */
export function createAuth(settings: Pick<ApiSettings, 'adapter' | 'baseUrl'>, forceServer = false): AuthApi {
  if (settings.adapter === 'http' || forceServer || inElectron()) return new HttpAuth(settings.baseUrl || DEFAULT_SERVER_URL);
  return new MockAuth();
}

/** True when the Welcome screen should be shown instead of the app. */
export function needsSignIn(settings: ApiSettings): boolean {
  if (settings.adapter === 'http') return !settings.token || !settings.baseUrl;
  return settings.signedOut === true;
}

/** Connecting tools and fetching models happen once per Mac; after that, signing in goes straight to the sessions. */
export const onboarding = {
  done(): boolean {
    try {
      return globalThis.localStorage?.getItem(ONBOARDED_KEY) === '1';
    } catch {
      return true;
    }
  },
  markDone(): void {
    try {
      globalThis.localStorage?.setItem(ONBOARDED_KEY, '1');
    } catch {
      /* private window */
    }
  },
};
