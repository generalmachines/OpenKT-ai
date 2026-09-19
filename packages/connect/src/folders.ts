import { join } from 'node:path';
import { readText, writeAtomic } from './fsx.js';
import type { ConnectEnv } from './types.js';

/**
 * Which space a folder's sessions go to (no `kt init` needed). ~/.openkt/folders.json maps a folder to a space;
 * the hook script appends git repositories it has not seen to ~/.openkt/folders.pending, and those start in the
 * person's personal space until someone files them. The JSON is written one folder per line because the sh hook
 * looks folders up with grep.
 */
export interface FolderMapping {
  path: string;
  /** null = personal space, decided. */
  space_id: string | null;
  space_name?: string;
  /** 'pending': seen by a hook, never decided (sessions go to the personal space meanwhile). */
  state: 'mapped' | 'personal' | 'pending';
  first_seen?: string;
}

interface FoldersFile {
  version: 1;
  folders: Record<string, { space_id: string | null; space_name?: string }>;
}

function read(env: ConnectEnv): FoldersFile {
  try {
    const parsed = JSON.parse(readText(join(env.openktHome, 'folders.json')) ?? '') as FoldersFile;
    if (parsed && typeof parsed.folders === 'object') return { version: 1, folders: parsed.folders };
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: 1, folders: {} };
}

function write(env: ConnectEnv, file: FoldersFile): void {
  const lines = Object.entries(file.folders)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, v]) => `    ${JSON.stringify(path)}: ${JSON.stringify({ space_id: v.space_id, ...(v.space_name ? { space_name: v.space_name } : {}) }).replace(/^\{"space_id":/, '{"space_id": ')}`);
  writeAtomic(join(env.openktHome, 'folders.json'), `{\n  "version": 1,\n  "folders": {\n${lines.join(',\n')}${lines.length ? '\n' : ''}  }\n}\n`, 0o600);
}

export function listFolders(env: ConnectEnv): FolderMapping[] {
  const file = read(env);
  const out: FolderMapping[] = Object.entries(file.folders).map(([path, v]) => ({
    path,
    space_id: v.space_id,
    ...(v.space_name ? { space_name: v.space_name } : {}),
    state: v.space_id ? 'mapped' : 'personal',
  }));
  const pending = readText(join(env.openktHome, 'folders.pending')) ?? '';
  const seen = new Set(out.map((f) => f.path));
  for (const line of pending.split('\n')) {
    const [path, when] = line.split('\t');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, space_id: null, state: 'pending', ...(when ? { first_seen: when } : {}) });
  }
  return out;
}

/** File a folder's sessions under a space (`null` = personal, decided). Takes effect on the next session there. */
export function mapFolder(env: ConnectEnv, path: string, spaceId: string | null, spaceName?: string): void {
  const file = read(env);
  file.folders[path.replace(/\/+$/, '') || '/'] = { space_id: spaceId, ...(spaceName ? { space_name: spaceName } : {}) };
  write(env, file);
}

export function unmapFolder(env: ConnectEnv, path: string): void {
  const file = read(env);
  delete file.folders[path];
  write(env, file);
}
