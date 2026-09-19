import { join } from 'node:path';
import { readText, writeAtomic } from './fsx.js';
import type { ConnectEnv, IntegrationOptions } from './types.js';

/** What apply wrote, so undo can put every file back exactly as it was. Lives in ~/.openkt/connect/state.json. */
export interface FileRecord {
  /** The copy made before the first write; absent when the file did not exist. */
  backup?: string;
  created: boolean;
  /** sha256 of what apply left in the file. If the file still hashes to this, undo restores the backup byte for byte. */
  written: string;
  /** false after a re-apply over a file that was edited since: undo removes OpenKT's entries instead of restoring. */
  restore?: boolean;
}

export interface ToolRecord {
  applied_at: string;
  options: IntegrationOptions;
  files: Record<string, FileRecord>;
}

export interface ConnectState {
  version: 1;
  tools: Record<string, ToolRecord>;
}

export function statePath(env: ConnectEnv): string {
  return join(env.openktHome, 'connect', 'state.json');
}

export function readState(env: ConnectEnv): ConnectState {
  const text = readText(statePath(env));
  if (!text) return { version: 1, tools: {} };
  try {
    const parsed = JSON.parse(text) as ConnectState;
    if (parsed && parsed.version === 1 && parsed.tools && typeof parsed.tools === 'object') return parsed;
  } catch {
    // A damaged state file only costs byte-identical undo; undo falls back to removing OpenKT's entries.
  }
  return { version: 1, tools: {} };
}

export function writeState(env: ConnectEnv, state: ConnectState): void {
  writeAtomic(statePath(env), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
