/**
 * Unsaved skill edits. The editor writes here on every change, so leaving the
 * editor any way at all — the ⌘K palette, the tray, a conflict, quitting the
 * app — never loses what was typed; the skill page offers to continue or
 * discard. Saving or discarding removes the draft.
 *
 * Kept in memory and mirrored to localStorage (this Mac only, never synced).
 * No `beforeunload` prompt: in Electron that silently blocks closing the window.
 */
import type { Id, SkillFileInput } from '../../api/types';

export interface SkillDraft {
  files: SkillFileInput[];
  changeNote: string;
  /** The version the edit started from; a save from here is a conflict if someone saved since. */
  baseVersion: number;
  /** The files at `baseVersion`, to tell edited from untouched. */
  baseFiles: SkillFileInput[];
  active: string;
}

const KEY = 'openkt.skill-drafts';

function load(): Map<Id, SkillDraft> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<Id, SkillDraft>) : {};
    return new Map(Object.entries(parsed).filter(([, d]) => Array.isArray(d?.files) && Array.isArray(d?.baseFiles) && typeof d?.baseVersion === 'number'));
  } catch {
    return new Map();
  }
}

let drafts: Map<Id, SkillDraft> | null = null;
const all = (): Map<Id, SkillDraft> => (drafts ??= load());
const listeners = new Set<() => void>();

function persist(): void {
  try {
    if (all().size) globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(all())));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* private window or full storage: the draft still lives in memory */
  }
}

export const skillDrafts = {
  get: (id: Id): SkillDraft | undefined => all().get(id),
  set(id: Id, draft: SkillDraft): void {
    all().set(id, draft);
    persist();
  },
  delete(id: Id): void {
    if (!all().delete(id)) return;
    persist();
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Tests only: forget everything. */
  clear(): void {
    drafts = new Map();
    persist();
    listeners.forEach((l) => l());
  },
};
