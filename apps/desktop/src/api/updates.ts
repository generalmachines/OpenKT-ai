/**
 * The renderer's view of in-app updates (main: src/main/update). Degrades like bridge.ts: in a browser, in
 * tests, or against an older main process there is no `update` bridge and every call returns null, so the
 * About screen says "updates come with the desktop app" and the sidebar pill stays hidden.
 */
import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatusDto } from '../shared/ipc';

export type UpdateStatus = UpdateStatusDto;

type Action = 'status' | 'check' | 'download' | 'install' | 'moveToApplications' | 'rollback' | 'seen';

interface LooseUpdateBridge {
  status?(): Promise<unknown>;
  check?(): Promise<unknown>;
  download?(): Promise<unknown>;
  install?(): Promise<unknown>;
  setAuto?(on: boolean): Promise<unknown>;
  moveToApplications?(): Promise<unknown>;
  rollback?(): Promise<unknown>;
  seen?(): Promise<unknown>;
  onEvent?(listener: (s: unknown) => void): () => void;
}

const bridge = (): LooseUpdateBridge | undefined =>
  typeof window === 'undefined' ? undefined : ((window.openkt as { update?: LooseUpdateBridge } | undefined)?.update ?? undefined);

function isStatus(v: unknown): v is UpdateStatus {
  const j = v as Partial<UpdateStatus> | null;
  return !!j && typeof j === 'object' && typeof j.version === 'string' && typeof j.phase === 'string' && typeof j.location === 'object';
}

async function call(action: Action | 'setAuto', arg?: boolean): Promise<UpdateStatus | null> {
  const b = bridge();
  const fn = b?.[action] as ((a?: boolean) => Promise<unknown>) | undefined;
  if (typeof fn !== 'function') return null;
  try {
    const r = await fn.call(b, arg);
    return isStatus(r) ? r : null;
  } catch {
    return null;
  }
}

export const updates = {
  available: (): boolean => typeof bridge()?.status === 'function',
  status: () => call('status'),
  check: () => call('check'),
  download: () => call('download'),
  install: () => call('install'),
  setAuto: (on: boolean) => call('setAuto', on),
  moveToApplications: () => call('moveToApplications'),
  rollback: () => call('rollback'),
  seen: () => call('seen'),
  onEvent(listener: (s: UpdateStatus) => void): () => void {
    const b = bridge();
    if (typeof b?.onEvent !== 'function') return () => undefined;
    return b.onEvent((s) => {
      if (isStatus(s)) listener(s);
    });
  },
};

/**
 * Live update status. `undefined` while asking, `null` when there is no update bridge.
 * `run(action)` performs an action and adopts the status it returns.
 */
export function useUpdateStatus(): { status: UpdateStatus | null | undefined; run: (action: Action | 'auto-on' | 'auto-off') => Promise<void> } {
  const [status, setStatus] = useState<UpdateStatus | null | undefined>(() => (updates.available() ? undefined : null));
  useEffect(() => {
    if (!updates.available()) return;
    let alive = true;
    void updates.status().then((s) => alive && setStatus(s));
    const off = updates.onEvent((s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const run = useCallback(async (action: Action | 'auto-on' | 'auto-off') => {
    const s = action === 'auto-on' ? await updates.setAuto(true) : action === 'auto-off' ? await updates.setAuto(false) : await updates[action]();
    if (s) setStatus(s);
  }, []);
  return { status, run };
}

export const formatBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
