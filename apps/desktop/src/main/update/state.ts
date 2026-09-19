/**
 * Persistent updater state (userData/updates/state.json) and the pending-verify state machine:
 *   install() writes `pending` {version, from, oldAppPath} just before the swap;
 *   the new version increments `pending.starts` on every launch until it has run healthily for a while,
 *   then clears it, deletes the old copy and records `lastUpdate` (shown once as "Updated to X — what's new");
 *   if a launch finds `starts` already at 2 (two starts never became healthy) it offers "Go back".
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PendingVerify {
  version: string;
  from: string;
  oldAppPath: string;
  installedAt: string;
  /** Launches of `version` that started while this marker was present. */
  starts: number;
}

export interface UpdaterState {
  auto: boolean;
  lastCheckedAt: string | null;
  pending: PendingVerify | null;
  /** Set by the healthy start after an update; cleared when the "what's new" note has been shown. */
  lastUpdate: { version: string; from: string; notes: string[]; at: string; seen: boolean } | null;
  /** Versions never to install again (rolled back). */
  blocked: string[];
  /** Release notes of the version `pending` points to, kept so "what's new" can show them. */
  pendingNotes: string[];
}

export const DEFAULT_STATE: UpdaterState = { auto: true, lastCheckedAt: null, pending: null, lastUpdate: null, blocked: [], pendingNotes: [] };

/** How many launches may start without becoming healthy before "Go back" is offered. */
export const MAX_UNHEALTHY_STARTS = 2;

export function readState(path: string): UpdaterState {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdaterState>;
    const p = j.pending && typeof j.pending === 'object' && typeof j.pending.version === 'string' ? j.pending : null;
    return {
      auto: j.auto !== false,
      lastCheckedAt: typeof j.lastCheckedAt === 'string' ? j.lastCheckedAt : null,
      pending: p ? { version: p.version, from: String(p.from ?? ''), oldAppPath: String(p.oldAppPath ?? ''), installedAt: String(p.installedAt ?? ''), starts: Number(p.starts) || 0 } : null,
      lastUpdate: j.lastUpdate && typeof j.lastUpdate === 'object' && typeof j.lastUpdate.version === 'string' ? { ...j.lastUpdate, notes: Array.isArray(j.lastUpdate.notes) ? j.lastUpdate.notes : [], seen: j.lastUpdate.seen === true } : null,
      blocked: Array.isArray(j.blocked) ? j.blocked.filter((v): v is string => typeof v === 'string') : [],
      pendingNotes: Array.isArray(j.pendingNotes) ? j.pendingNotes.filter((v): v is string => typeof v === 'string') : [],
    };
  } catch {
    return { ...DEFAULT_STATE, blocked: [], pendingNotes: [] };
  }
}

export function writeState(path: string, state: UpdaterState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export type LaunchOutcome =
  /** Normal launch, nothing pending. */
  | { kind: 'normal' }
  /** We are the freshly installed version; call `markHealthy` once the app has run for a while. */
  | { kind: 'verifying'; pending: PendingVerify; starts: number }
  /** Two starts of this version never became healthy: offer "Go back to <from>". */
  | { kind: 'offer-rollback'; pending: PendingVerify }
  /** A marker for another version: the swap did not happen (old bundle restored). */
  | { kind: 'swap-failed'; pending: PendingVerify };

/** Pure: given the state on disk and the running version, what happened and what to store. */
export function onLaunch(state: UpdaterState, currentVersion: string, fs: { exists(p: string): boolean } = { exists: existsSync }): { outcome: LaunchOutcome; state: UpdaterState } {
  const p = state.pending;
  if (!p) return { outcome: { kind: 'normal' }, state };
  if (p.version !== currentVersion) {
    return { outcome: { kind: 'swap-failed', pending: p }, state: { ...state, pending: null, pendingNotes: [] } };
  }
  if (p.starts >= MAX_UNHEALTHY_STARTS && p.oldAppPath && fs.exists(p.oldAppPath)) {
    return { outcome: { kind: 'offer-rollback', pending: p }, state };
  }
  const next = { ...p, starts: p.starts + 1 };
  return { outcome: { kind: 'verifying', pending: next, starts: next.starts }, state: { ...state, pending: next } };
}

/** The new version ran fine: forget the marker, remember the update for the "what's new" note. */
export function markHealthy(state: UpdaterState, now = new Date()): UpdaterState {
  const p = state.pending;
  if (!p) return state;
  return { ...state, pending: null, pendingNotes: [], lastUpdate: { version: p.version, from: p.from, notes: state.pendingNotes, at: now.toISOString(), seen: false } };
}

/** "Go back" chosen: block this version and hand the swap back. */
export function markRolledBack(state: UpdaterState): UpdaterState {
  const p = state.pending;
  const blocked = p && !state.blocked.includes(p.version) ? [...state.blocked, p.version] : state.blocked;
  return { ...state, pending: null, pendingNotes: [], blocked };
}
