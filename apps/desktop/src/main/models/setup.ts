/**
 * First-run facts about the on-device AI: how much will be downloaded, whether the disk has
 * room for it, whether this Mac gets the smaller model, and which helpers are inside the app.
 * No `electron` import (see manifest.ts).
 */
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GIB, chooseTier } from './manifest';
import type { ModelStatus } from './store';

/** Room kept free beyond the download itself, so a Mac is never filled to the brim. */
export const DISK_HEADROOM_BYTES = 1 * GIB;

export interface SetupInfo {
  /** Every model this Mac will use, whether or not it is on disk yet. */
  totalBytes: number;
  /** What is still to download. */
  remainingBytes: number;
  /** Free space where the models live. null when it could not be read (then it is not treated as low). */
  freeBytes: number | null;
  /** `remainingBytes` plus headroom. */
  neededBytes: number;
  enoughDisk: boolean;
  totalMemBytes: number;
  /** ≤ 8 GB of memory: the smaller model line-up. */
  smallModel: boolean;
  paused: boolean;
  /** Inside the app, nothing to download. false = missing from this build (a development build, usually). */
  bundled: { runtime: boolean; transcriber: boolean; textReader: boolean };
}

type StatFs = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/** Free bytes on the volume holding `dir`. The directory may not exist yet, so walk up to one that does. */
export async function freeBytes(dir: string, stat: StatFs = statfs): Promise<number | null> {
  let at = dir;
  for (let i = 0; i < 32; i += 1) {
    try {
      const s = await stat(at);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
  return null;
}

export function remainingBytes(models: readonly Pick<ModelStatus, 'totalBytes' | 'receivedBytes' | 'state'>[]): number {
  return models.reduce((n, m) => n + (m.state === 'ready' ? 0 : Math.max(0, m.totalBytes - m.receivedBytes)), 0);
}

export function diskCheck(free: number | null, remaining: number): { neededBytes: number; enoughDisk: boolean } {
  const neededBytes = remaining > 0 ? remaining + DISK_HEADROOM_BYTES : 0;
  return { neededBytes, enoughDisk: free === null || free >= neededBytes };
}

export interface SetupInputs {
  models: readonly ModelStatus[];
  modelsDir: string;
  totalMemBytes: number;
  paused: boolean;
  binaries: { runtime: string; transcriber: string; textReader: string };
  stat?: StatFs;
  exists?: (path: string) => boolean;
}

export async function setupInfo(i: SetupInputs): Promise<SetupInfo> {
  const exists = i.exists ?? existsSync;
  const remaining = remainingBytes(i.models);
  const free = await freeBytes(i.modelsDir, i.stat);
  return {
    totalBytes: i.models.reduce((n, m) => n + m.totalBytes, 0),
    remainingBytes: remaining,
    freeBytes: free,
    ...diskCheck(free, remaining),
    totalMemBytes: i.totalMemBytes,
    smallModel: chooseTier(i.totalMemBytes) === '2b',
    paused: i.paused,
    bundled: { runtime: exists(i.binaries.runtime), transcriber: exists(i.binaries.transcriber), textReader: exists(i.binaries.textReader) },
  };
}
