/**
 * The on-device AI download as the renderer sees it: one hook shared by the first-run screen,
 * Settings → Models, the sidebar footer and the voice pill, plus the pure rules they all use
 * (what phase it is in, how far along, how long is left, what to call each model).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { modelsSetup, type ModelRole, type ModelRow, type ModelsSetupInfoDto } from '../api/setup-bridge';

export type { ModelRole, ModelRow, ModelsSetupInfoDto };

/** Each model in the app's words: what it does for the person, never what it is. */
export const ROLE_COPY: Record<ModelRole, { name: string; why: string }> = {
  embed: { name: 'Search', why: 'finds your notes by what they mean' },
  llm: { name: 'Understanding', why: 'reads what you save and pulls out what matters' },
  whisper: { name: 'Speech', why: 'turns what you say into text' },
  mmproj: { name: 'Images', why: 'describes what is in a screenshot' },
};

export const ROLE_ORDER: readonly ModelRole[] = ['embed', 'llm', 'whisper', 'mmproj'];

/**
 * unavailable — no desktop app (a browser, the tests) · checking — first read in flight ·
 * idle — something is missing and nothing is moving · low-disk — not enough room to start.
 */
export type SetupPhase = 'unavailable' | 'checking' | 'ready' | 'downloading' | 'paused' | 'low-disk' | 'error' | 'idle';

export const LOW_DISK = 'low_disk';

export function setupPhase(rows: readonly ModelRow[] | null | undefined, info: ModelsSetupInfoDto | null | undefined, failure: string | null): SetupPhase {
  if (rows === undefined || info === undefined) return 'checking';
  if (rows === null) return 'unavailable';
  if (rows.length > 0 && rows.every((r) => r.state === 'ready')) return 'ready';
  if (info?.paused) return 'paused';
  if (rows.some((r) => r.state === 'downloading' || r.state === 'verifying')) return 'downloading';
  if (failure === LOW_DISK || (info !== null && !info.enoughDisk)) return 'low-disk';
  if ((failure !== null && failure !== 'paused') || rows.some((r) => r.state === 'error')) return 'error';
  return 'idle';
}

export function totals(rows: readonly ModelRow[]): { received: number; total: number; remaining: number; fraction: number } {
  const total = rows.reduce((s, r) => s + r.totalBytes, 0);
  const received = rows.reduce((s, r) => s + (r.state === 'ready' ? r.totalBytes : Math.min(r.receivedBytes, r.totalBytes)), 0);
  return { received, total, remaining: Math.max(0, total - received), fraction: total > 0 ? received / total : 0 };
}

/** Whole percent, never 100 until every model really is on disk. */
export function percent(rows: readonly ModelRow[]): number {
  if (rows.length > 0 && rows.every((r) => r.state === 'ready')) return 100;
  return Math.min(99, Math.floor(totals(rows).fraction * 100));
}

export function speed(rows: readonly ModelRow[]): number {
  return rows.reduce((s, r) => s + (r.state === 'downloading' ? r.bytesPerSec : 0), 0);
}

/** Seconds left at the current speed; null when nothing is moving. */
export function etaSeconds(rows: readonly ModelRow[]): number | null {
  const bps = speed(rows);
  if (bps <= 0) return null;
  return Math.ceil(totals(rows).remaining / bps);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function formatSpeed(bps: number): string {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1e3))} KB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `about ${h} h${m ? ` ${m} min` : ''} left`;
}

/** A download error in plain words. The raw message stays available as a tooltip. */
export function plainError(message: string | undefined): string {
  const m = message ?? '';
  if (/checksum|mismatch|damaged/i.test(m)) return 'The file arrived damaged, so it was thrown away. Try again.';
  if (/ENOSPC|no space/i.test(m)) return 'This Mac ran out of space during the download.';
  return 'The download stopped. Check the internet connection, then try again.';
}

/** "Finishing setup — 62%": what a feature that needs a model says instead of failing. */
export const finishingSetup = (pct: number) => `Finishing setup — ${pct}%`;

function merge(prev: ModelRow[] | null | undefined, row: ModelRow): ModelRow[] | null | undefined {
  if (!prev) return prev;
  const next = prev.some((r) => r.role === row.role) ? prev.map((r) => (r.role === row.role ? { ...r, ...row } : r)) : [...prev, row];
  return next.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
}

export interface ModelsSetupState {
  /** undefined while reading · null without the desktop app. */
  rows: ModelRow[] | null | undefined;
  info: ModelsSetupInfoDto | null | undefined;
  phase: SetupPhase;
  percent: number;
  /** Why the last start stopped, when it did (`low_disk`, a message). */
  failure: string | null;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Re-reads free space, then starts again (joins a run already in flight). */
  retry(): Promise<void>;
}

/**
 * Live model state. `autoStart` (the first-run screen) starts the download on entry — unless
 * everything is there, the person paused it, or the disk is too full, which is said instead.
 */
export function useModelsSetup(opts: { autoStart?: boolean } = {}): ModelsSetupState {
  const [rows, setRows] = useState<ModelRow[] | null | undefined>(undefined);
  const [info, setInfo] = useState<ModelsSetupInfoDto | null | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const alive = useRef(true);
  const autoStarted = useRef(false);
  /** Progress that arrived before the first read; applied on top of it. */
  const early = useRef(new Map<ModelRole, ModelRow>());
  const autoStart = opts.autoStart === true;

  const read = useCallback(async () => {
    const [r, i] = await Promise.all([modelsSetup.status(), modelsSetup.setupInfo()]);
    if (alive.current) {
      let next: ModelRow[] | null | undefined = r ? [...r].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) : r;
      for (const row of early.current.values()) next = merge(next, row);
      early.current.clear();
      setRows(next);
      setInfo(i);
    }
    return { r, i };
  }, []);

  const run = useCallback(async () => {
    setFailure(null);
    const err = await modelsSetup.ensure();
    if (!alive.current) return;
    setFailure(err === 'paused' ? null : err);
    await read();
  }, [read]);

  useEffect(() => {
    alive.current = true;
    const off = modelsSetup.onProgress((row) =>
      setRows((prev) => {
        if (prev === undefined) early.current.set(row.role, row);
        return merge(prev, row);
      }),
    );
    void read().then(({ r, i }) => {
      if (!autoStart || autoStarted.current || !r || r.length === 0) return;
      if (r.every((m) => m.state === 'ready') || i?.paused || (i && !i.enoughDisk)) return;
      autoStarted.current = true;
      void run();
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [autoStart, read, run]);

  // Once every model is on disk, read again so the facts (free space, paused) match.
  const allReady = Boolean(rows?.length && rows.every((r) => r.state === 'ready'));
  useEffect(() => {
    if (allReady) void read();
  }, [allReady, read]);

  const pause = useCallback(async () => {
    const i = await modelsSetup.pause();
    if (alive.current && i) setInfo(i);
  }, []);

  const resume = useCallback(async () => {
    setInfo((prev) => (prev ? { ...prev, paused: false } : prev));
    await run();
  }, [run]);

  const retry = useCallback(async () => {
    const { i } = await read();
    if (i && !i.enoughDisk) {
      if (alive.current) setFailure(LOW_DISK);
      return;
    }
    await run();
  }, [read, run]);

  return { rows, info, phase: setupPhase(rows, info, failure), percent: rows ? percent(rows) : 0, failure, pause, resume, retry };
}

/** For the voice pill: is speech ready, and if not, how far along is the whole setup. Unknown counts as ready. */
export async function speechReadiness(): Promise<{ ready: boolean; percent: number }> {
  const rows = await modelsSetup.status();
  const whisper = rows?.find((r) => r.role === 'whisper');
  if (!rows || !whisper || whisper.state === 'ready') return { ready: true, percent: 100 };
  return { ready: false, percent: percent(rows) };
}
