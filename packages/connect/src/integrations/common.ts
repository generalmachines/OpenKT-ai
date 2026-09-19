import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_SCRIPT, HOOK_SCRIPT_VERSION, SKILL_FILES } from '../assets.generated.js';
import type { FileEdit } from '../engine.js';
import { ConnectError } from '../errors.js';
import { appendItem, getAt, parseJsonc, removeItems, removeMember, setMember } from '../jsonc.js';
import type { ConnectEnv, Detection } from '../types.js';

export const MCP_NAME = 'openkt';

export function hookScriptPath(env: ConnectEnv): string {
  return join(env.openktHome, 'hooks', 'openkt-hook.sh');
}

/** POSIX single-quoting, only when needed (tools run hook commands through a shell). */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(env: ConnectEnv, tool: string, event: string): string {
  return `/bin/sh ${shQuote(hookScriptPath(env))} ${tool} ${event}`;
}

/** The OpenKT MCP server as a local stdio command: the hook script forwards to the server with the stored credentials. */
export function mcpCommand(env: ConnectEnv): { command: string; args: string[] } {
  return { command: '/bin/sh', args: [hookScriptPath(env), 'mcp'] };
}

/** A hook command installed by openkt-connect, or by the old `kt` CLI (Python hooks, `kt prime`). */
export function isOpenktCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  return cmd.includes('openkt-hook.sh') || cmd.includes('/.openkt/hooks/') || /(^|[\s/])(kt|openkt) prime(\s|$)/.test(cmd);
}

export function hookScriptEdit(env: ConnectEnv): FileEdit {
  return {
    file: hookScriptPath(env),
    part: 'hook-script',
    summary: `the OpenKT hook script (v${HOOK_SCRIPT_VERSION}): sh + curl, talks to the server directly`,
    mode: 0o755,
    shared: true,
    apply: () => HOOK_SCRIPT,
    remove: () => null,
    check: (cur) => cur === HOOK_SCRIPT,
  };
}

export function skillEdits(dir: string, part = 'skill'): FileEdit[] {
  return Object.entries(SKILL_FILES).map(([rel, content]) => ({
    file: join(dir, rel),
    part,
    summary: rel === 'SKILL.md' ? 'the openkt skill (when to recall, what to save, which space)' : `openkt skill reference ${rel}`,
    apply: () => content,
    remove: () => null,
    check: (cur) => cur === content,
  }));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `path` in a JSON settings file set to `value`; everything else in the file is left byte for byte. */
export function jsonMemberEdit(opts: { file: string; part: string; summary: string; path: string[]; value: unknown; seed?: string }): FileEdit {
  return {
    file: opts.file,
    part: opts.part,
    summary: opts.summary,
    apply(cur) {
      const base = cur ?? opts.seed ?? '';
      if (cur !== null && sameJson(getAt(parseJsonc(cur), opts.path), opts.value)) return cur;
      return setMember(base, opts.path, opts.value);
    },
    remove(cur) {
      if (cur === null) return null;
      return getAt(parseJsonc(cur), opts.path) === undefined ? cur : removeMember(cur, opts.path);
    },
    check(cur) {
      if (cur === null) return false;
      return sameJson(getAt(parseJsonc(cur), opts.path), opts.value);
    },
  };
}

/**
 * Hook entries in a JSON file whose hooks live at `root` as `{ <event>: [entry, …] }` (Claude Code, Codex, Gemini CLI,
 * Cursor, Windsurf). OpenKT's entries are recognised by `isOurs`; apply replaces them, remove takes them out and
 * leaves every other entry alone.
 */
export function hooksEdit(opts: {
  file: string;
  part?: string;
  summary: string;
  root: string[];
  entries: Record<string, unknown[]>;
  isOurs: (entry: unknown) => boolean;
  seed?: string;
}): FileEdit {
  const allEvents = (doc: unknown) => Object.keys((getAt(doc, opts.root) as Record<string, unknown> | undefined) ?? {});
  const strip = (text: string): string => {
    let out = text;
    const doc = parseJsonc(out);
    for (const event of allEvents(doc)) {
      const before = getAt(doc, [...opts.root, event]);
      if (!Array.isArray(before) || !before.some(opts.isOurs)) continue;
      out = removeItems(out, [...opts.root, event], opts.isOurs);
      const after = getAt(parseJsonc(out), [...opts.root, event]);
      if (Array.isArray(after) && after.length === 0) out = removeMember(out, [...opts.root, event]);
    }
    return out;
  };
  const ours = (doc: unknown, event: string) => {
    const list = getAt(doc, [...opts.root, event]);
    return Array.isArray(list) ? list.filter(opts.isOurs) : [];
  };
  return {
    file: opts.file,
    part: opts.part ?? 'hooks',
    summary: opts.summary,
    apply(cur) {
      if (cur !== null && this.check(cur) === true) return cur;
      let out = cur === null || !cur.trim() ? (opts.seed ?? '') : strip(cur);
      for (const [event, list] of Object.entries(opts.entries)) for (const entry of list) out = appendItem(out, [...opts.root, event], entry);
      return out;
    },
    remove(cur) {
      if (cur === null) return null;
      const out = strip(cur);
      if (out === cur) return cur;
      const rootValue = getAt(parseJsonc(out), opts.root);
      if (rootValue && typeof rootValue === 'object' && Object.keys(rootValue).length === 0) return removeMember(out, opts.root);
      return out;
    },
    check(cur) {
      if (cur === null) return false;
      const doc = parseJsonc(cur);
      const events = new Set([...allEvents(doc), ...Object.keys(opts.entries)]);
      for (const event of events) if (!sameJson(ours(doc, event), opts.entries[event] ?? [])) return false;
      return true;
    },
  };
}

/** A block between marker lines in a text file (TOML, Markdown). The rest of the file is left byte for byte. */
export function markerBlockEdit(opts: {
  file: string;
  part: string;
  summary: string;
  begin: string;
  end: string;
  block: string;
  /** Extra text to take out on apply/remove (a legacy entry written before the markers existed). */
  stripLegacy?: (text: string) => string;
  /** A reason the file cannot be edited safely (e.g. the same name defined another way). */
  conflict?: (textWithoutBlock: string) => string | null;
}): FileEdit {
  const full = `${opts.begin}\n${opts.block.replace(/\n?$/, '\n')}${opts.end}\n`;
  const without = (text: string): string => {
    const b = text.indexOf(opts.begin);
    const e = text.indexOf(opts.end, b);
    let out = text;
    if (b >= 0 && e > b) {
      let endAt = e + opts.end.length;
      if (out[endAt] === '\n') endAt++;
      let startAt = b;
      // Also take the blank line apply put in front of the block.
      if (startAt >= 2 && out.slice(startAt - 2, startAt) === '\n\n') startAt--;
      out = out.slice(0, startAt) + out.slice(endAt);
    }
    return opts.stripLegacy ? opts.stripLegacy(out) : out;
  };
  return {
    file: opts.file,
    part: opts.part,
    summary: opts.summary,
    apply(cur) {
      if (cur !== null && cur.includes(full)) {
        const conflict = opts.conflict?.(without(cur));
        if (conflict) throw new ConnectError('conflict', conflict, { file: opts.file });
        return cur;
      }
      const rest = cur === null ? '' : without(cur);
      const conflict = opts.conflict?.(rest);
      if (conflict) throw new ConnectError('conflict', conflict, { file: opts.file });
      if (!rest.trim()) return full;
      return `${rest.replace(/\n*$/, '\n')}\n${full}`;
    },
    remove(cur) {
      if (cur === null) return null;
      const out = without(cur);
      return out === cur ? cur : out;
    },
    check(cur) {
      if (cur === null) return false;
      const conflict = opts.conflict?.(without(cur));
      if (conflict) return conflict;
      return cur.includes(full);
    },
  };
}

export function onPath(env: ConnectEnv, binary: string): string | undefined {
  for (const dir of env.path) {
    const p = join(dir, binary);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Installed when any of the paths (config dirs, app bundles) exists or the binary is on PATH. */
export function detectAny(env: ConnectEnv, paths: string[], binary?: string): Detection {
  for (const p of paths) if (existsSync(p)) return { installed: true, path: p };
  const bin = binary ? onPath(env, binary) : undefined;
  return bin ? { installed: true, path: bin } : { installed: false };
}
