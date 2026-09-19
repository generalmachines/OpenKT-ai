import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createAuth, createClient, loadApiSettings, needsSignIn, saveApiSettings, type ApiSettings, type OpenKTClient } from '../api';
import { ApiProvider } from '../api/hooks';

/**
 * Who is signed in, and where. Owns the client: signing in swaps it in place
 * (no reload), and a 401 from any call drops the token so the routes fall back
 * to the Welcome screen with "Please sign in again."
 */
export interface Connection {
  settings: ApiSettings;
  /** Nobody is signed in: show Welcome. */
  signedOut: boolean;
  /** The server stopped accepting the saved session. */
  expired: boolean;
  /** Store a new session (or switch to sample data) and start using it. */
  connect(next: ApiSettings): Promise<void>;
  /** Tells the server, forgets the token, keeps the email for next time. */
  signOut(): Promise<void>;
}

const Ctx = createContext<Connection | null>(null);

/** Without a provider (component tests that inject a client) the app is simply "signed in". */
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
  const live = useRef(settings);
  live.current = settings;

  const onUnauthorized = useCallback(() => {
    if (!live.current.token) return; // several calls can fail at once; the first one already signed out
    const next = { ...live.current, token: '' };
    live.current = next;
    setExpired(true);
    setSettings(next);
    void saveApiSettings(next);
  }, []);

  const client = useMemo(() => createClient(settings, onUnauthorized), [settings, onUnauthorized]);

  const connect = useCallback(async (next: ApiSettings) => {
    await saveApiSettings(next);
    setExpired(false);
    setSettings(next);
  }, []);

  const signOut = useCallback(async () => {
    const was = live.current;
    const next: ApiSettings = { ...was, token: '', signedOut: was.adapter === 'mock' ? true : undefined };
    if (was.adapter === 'http' && was.token) await createAuth(was).logOut(was.token);
    await saveApiSettings(next);
    setExpired(false);
    setSettings(next);
  }, []);

  // Another window (an overlay) may have saved new settings.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === 'openkt.api' && void loadApiSettings().then(setSettings);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // The on-device worker (main process) needs to know which server this app is signed in to; the
  // token itself stays in the keychain, where main reads it.
  useEffect(() => {
    void window.openkt?.worker?.configure({ baseUrl: settings.baseUrl, adapter: settings.adapter, signedIn: !needsSignIn(settings) }).catch(() => undefined);
  }, [settings]);

  const value = useMemo<Connection>(() => ({ settings, expired, signedOut: needsSignIn(settings), connect, signOut }), [settings, expired, connect, signOut]);

  return (
    <Ctx.Provider value={value}>
      <ApiProvider client={client}>{children}</ApiProvider>
    </Ctx.Provider>
  );
}
