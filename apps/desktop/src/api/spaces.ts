/**
 * Small pure helpers for spaces, shared by both adapters and the screens:
 * the slug a name becomes, the next free one when it is taken, and reading a
 * join code out of whatever someone pasted.
 */
import { ApiError } from './errors';
import type { Id, Space } from './types';

/** The server's rule for a project slug: lowercase kebab, 2–41 characters, starting with a letter or digit. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const SLUG_MAX = 41;

/** "Northgate — Q4 launch" → "northgate-q4-launch". A name with no Latin letters or digits becomes "space". */
export function spaceSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  if (base.length >= 2) return base;
  return base ? `${base}-space` : 'space';
}

/** `n` = 1 is the slug itself; 2 and up add `-n`, cutting the base so the whole stays within 41 characters. */
export function slugWithSuffix(base: string, n: number): string {
  if (n <= 1) return base;
  const tail = `-${n}`;
  return `${base.slice(0, SLUG_MAX - tail.length).replace(/-+$/, '')}${tail}`;
}

/** The first of `base`, `base-2`, `base-3`… that is not in `taken`. */
export function nextFreeSlug(base: string, taken: ReadonlySet<string>, from = 1): { slug: string; n: number } {
  for (let n = Math.max(1, from); ; n += 1) {
    const slug = slugWithSuffix(base, n);
    if (!taken.has(slug)) return { slug, n };
  }
}

/**
 * The slug is someone else's already. A 409 from a server that says so; the
 * server today answers 400 "project slug already exists" for the same thing.
 */
export function isSlugTaken(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.kind === 'conflict') return true;
  return e.kind === 'invalid' && /slug already exists|already taken|slug_taken/i.test(`${e.code} ${e.message}`);
}

/**
 * What someone pasted to join a space: a whole link (`https://…/join/abc123`,
 * `openkt://join/abc123`, `…?code=abc123`) or just the code. Returns the code,
 * or '' when there is nothing that looks like one.
 */
export function joinCodeFrom(input: string): string {
  const text = input.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    const q = url.searchParams.get('code') ?? url.searchParams.get('join');
    if (q) return q.trim();
    const parts = `${url.host}${url.pathname}`.split('/').filter(Boolean);
    const at = parts.lastIndexOf('join');
    const code = at >= 0 && parts[at + 1] ? parts[at + 1]! : parts[parts.length - 1];
    return code && code !== 'join' ? decodeURIComponent(code) : '';
  } catch {
    /* not a URL: the code itself */
  }
  return /^[A-Za-z0-9_-]{4,200}$/.test(text) ? text : '';
}

// ── description, kept on this Mac ─────────────────────────────────────────
// The server's projects have no description column yet. What the person typed
// stays on this Mac, keyed by space id, and shows on their own screens only.

const DESCRIPTIONS = 'openkt.space-descriptions';

function readDescriptions(): Record<string, string> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(DESCRIPTIONS) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function localDescription(id: Id): string {
  const v = readDescriptions()[id];
  return typeof v === 'string' ? v : '';
}

export function setLocalDescription(id: Id, text: string): void {
  const all = readDescriptions();
  if (text.trim()) all[id] = text.trim().slice(0, 500);
  else delete all[id];
  try {
    globalThis.localStorage?.setItem(DESCRIPTIONS, JSON.stringify(all));
  } catch {
    /* private window: the description simply does not persist */
  }
}

// ── the space to save into, remembered ────────────────────────────────────
// Every save surface (new note, voice, screenshot) starts on the space used
// last. Overlays are separate windows, so this lives in localStorage.

const LAST_SPACE = 'openkt.last-space';

export function lastSpaceId(): Id {
  try {
    return globalThis.localStorage?.getItem(LAST_SPACE) ?? '';
  } catch {
    return '';
  }
}

export function rememberSpace(id: Id): void {
  if (!id) return;
  try {
    globalThis.localStorage?.setItem(LAST_SPACE, id);
  } catch {
    /* nothing to remember with */
  }
}

/** Spaces a save can go into: a reader cannot add to a space. */
export const writableSpaces = (spaces: readonly Space[]): Space[] => spaces.filter((s) => s.myRole !== 'reader');

/** The last space saved into, while it is still there and writable; else Personal; else the first. */
export function defaultSpaceId(spaces: readonly Space[], remembered: Id = lastSpaceId()): Id {
  const usable = writableSpaces(spaces);
  return (usable.find((s) => s.id === remembered) ?? usable.find((s) => s.personal) ?? usable[0])?.id ?? '';
}
