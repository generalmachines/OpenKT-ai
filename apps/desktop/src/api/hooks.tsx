import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OpenKTClient } from './client';

const ClientContext = createContext<OpenKTClient | null>(null);

export function ApiProvider({ client, children }: { client: OpenKTClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): OpenKTClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('useClient must be used inside <ApiProvider>');
  return c;
}

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Small read hook: runs `fn`, re-runs when `deps` change or when the client
 * reports a mutation. Previous data stays on screen during a refetch so rows
 * do not flicker when a role changes.
 */
export function useQuery<T>(fn: (client: OpenKTClient) => Promise<T>, deps: readonly unknown[]): QueryState<T> {
  const client = useClient();
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => client.subscribe(reload), [client, reload]);

  useEffect(() => {
    let live = true;
    fnRef.current(client).then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) => live && setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick, ...deps]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}
