import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createClient, loadApiSettings, needsConnect, saveApiSettings, type ApiSettings, type OpenKTClient } from '../api';
import { ApiProvider } from '../api/hooks';

/**
 * Which server the app talks to, as whom. Owns the client: saving new
 * settings swaps it in place (no reload), and a 401 from any call drops the
 * token so the routes fall back to the Connect screen.
 */
export interface Connection {
  settings: ApiSettings;
  /** No usable token, or a fresh install that has not chosen yet. */
  signedOut: boolean;
  /** Set after the server refused the saved token. */
  expired: boolean;
  connect(next: ApiSettings): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<Connection | null>(null);

/** Without a provider (component tests that inject a client) the app is simply "connected". */
const INERT: Connection = {
  settings: { adapter: 'mock', baseUrl: '', token: '' },
  signedOut: false,
  expired: false,
  connect: async () => undefined,
  signOut: async () => undefined,
};

export function useConnection(): Connection {
  return useContext(Ctx) ?? INERT;
}

/** For tests and stories that inject a client and never sign out. */
export function StaticConnection({ client, settings, children }: { client: OpenKTClient; settings?: Partial<ApiSettings>; children: ReactNode }) {
  const value = useMemo<Connection>(
    () => ({
      settings: { adapter: client.kind, baseUrl: '', token: '', ...settings },
      signedOut: false,
      expired: false,
      connect: async () => undefined,
      signOut: async () => undefined,
    }),
    [client, settings],
  );
  return (
    <Ctx.Provider value={value}>
      <ApiProvider client={client}>{children}</ApiProvider>
    </Ctx.Provider>
  );
}

export function ConnectionProvider({ initial, children }: { initial: ApiSettings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial);
  const [expired, setExpired] = useState(false);
  const [firstRunDone, setFirstRunDone] = useState(false);
  const live = useRef(settings);
  live.current = settings;

  const onUnauthorized = useCallback(() => {
    const next = { ...live.current, token: '' };
    setExpired(true);
    setSettings(next);
    void saveApiSettings(next);
  }, []);

  const client = useMemo(() => createClient(settings, onUnauthorized), [settings, onUnauthorized]);

  const connect = useCallback(async (next: ApiSettings) => {
    await saveApiSettings(next);
    setExpired(false);
    setFirstRunDone(true);
    setSettings(next);
  }, []);

  const signOut = useCallback(async () => {
    const next: ApiSettings = { ...live.current, adapter: 'http', token: '' };
    await saveApiSettings(next);
    setSettings(next);
  }, []);

  // Another window (an overlay) may have saved new settings.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === 'openkt.api' && void loadApiSettings().then(setSettings);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<Connection>(
    () => ({
      settings,
      expired,
      signedOut: !firstRunDone && needsConnect(settings, Boolean(window.openkt)),
      connect,
      signOut,
    }),
    [settings, expired, firstRunDone, connect, signOut],
  );

  return (
    <Ctx.Provider value={value}>
      <ApiProvider client={client}>{children}</ApiProvider>
    </Ctx.Provider>
  );
}
