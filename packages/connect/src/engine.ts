import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigParseError, ConnectError } from './errors.js';
import { backup, readText, removeFile, sha256, writeAtomic } from './fsx.js';
import { JsoncSyntaxError } from './jsonc.js';
import { readState, writeState, type FileRecord, type ToolRecord } from './state.js';
import type { Capabilities, Change, ConnectEnv, Detection, GuidedSetup, Integration, IntegrationKind, IntegrationOptions, StatusReport } from './types.js';

/**
 * One file an integration owns a part of. Edits are pure text → text functions, so plan() is a dry run of apply(),
 * and tests can check them without touching a disk.
 */
export interface FileEdit {
  file: string;
  /** Which capability this file provides: 'mcp', 'hooks', 'skill', 'hook-script', … (status reports per part). */
  part: string;
  summary: string;
  mode?: number;
  /** Shared by several integrations (the hook script): undo leaves it while another integration still uses it. */
  shared?: boolean;
  /** The content with OpenKT's part in place. null = the file should not exist. Throws JsoncSyntaxError / ConfigParseError. */
  apply(current: string | null): string | null;
  /** The content with OpenKT's part taken out (used when the file changed since apply, so the backup cannot be restored). */
  remove(current: string | null): string | null;
  /** Is OpenKT's part present and current? A string is a reason the part needs attention (e.g. another server named openkt). */
  check(current: string | null): boolean | string;
}

export interface FileIntegrationSpec {
  id: string;
  name: string;
  kind: IntegrationKind;
  capabilities: Capabilities;
  nativeMemoryNote?: string;
  docs: string[];
  detect(env: ConnectEnv): Promise<Detection> | Detection;
  edits(env: ConnectEnv, options: IntegrationOptions): FileEdit[];
  /** Things the person still has to do after apply (e.g. approve hooks in Codex). Shown with a connected status. */
  afterApply?: string[];
  guide?(env: ConnectEnv): Promise<GuidedSetup>;
}

function wrapParse(file: string, fn: () => string | null): string | null {
  try {
    return fn();
  } catch (err) {
    if (err instanceof JsoncSyntaxError) throw new ConfigParseError(file, err.message);
    throw err;
  }
}

function optionsFor(env: ConnectEnv, id: string, options?: IntegrationOptions): IntegrationOptions {
  return { nativeMemory: true, ...(readState(env).tools[id]?.options ?? {}), ...(options ?? {}) };
}

interface FilePlan {
  file: string;
  edits: FileEdit[];
  before: string | null;
  after: string | null;
  summary: string;
  mode: number | undefined;
  shared: boolean;
}

/** Edits are grouped per file and applied in order, so two parts of one settings file (MCP + hooks) compose. */
function groupByFile(edits: FileEdit[]): Map<string, FileEdit[]> {
  const byFile = new Map<string, FileEdit[]>();
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  return byFile;
}

function computePlan(spec: FileIntegrationSpec, env: ConnectEnv, options: IntegrationOptions): FilePlan[] {
  return [...groupByFile(spec.edits(env, options))].map(([file, edits]) => {
    const before = readText(file);
    const after = edits.reduce<string | null>((cur, edit) => wrapParse(file, () => edit.apply(cur)), before);
    return {
      file,
      edits,
      before,
      after,
      summary: edits.map((e) => e.summary).join('; '),
      mode: edits.find((e) => e.mode !== undefined)?.mode,
      shared: edits.every((e) => e.shared === true),
    };
  });
}

function toChange(file: string, before: string | null, after: string | null, summary: string): Change {
  return { file, action: before === null ? 'create' : after === null ? 'delete' : 'modify', summary };
}

function removeEmptyDirs(dir: string, stopAt: string): void {
  let d = dir;
  while (d.startsWith(stopAt) && d !== stopAt && existsSync(d) && readdirSync(d).length === 0) {
    rmdirSync(d);
    d = dirname(d);
  }
}

export function defineFileIntegration(spec: FileIntegrationSpec): Integration {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    capabilities: spec.capabilities,
    ...(spec.nativeMemoryNote ? { nativeMemoryNote: spec.nativeMemoryNote } : {}),
    docs: spec.docs,
    detect: async (env) => spec.detect(env),
    ...(spec.guide ? { guide: spec.guide } : {}),

    async status(env): Promise<StatusReport> {
      const parts: Record<string, boolean> = {};
      const reasons: string[] = [];
      let attention = false;
      const sharedParts = new Set<string>();
      for (const edit of spec.edits(env, optionsFor(env, spec.id))) {
        if (edit.shared) sharedParts.add(edit.part);
        let ok: boolean | string;
        try {
          ok = wrapParse(edit.file, () => {
            const r = edit.check(readText(edit.file));
            return typeof r === 'string' ? r : r ? 'ok' : null;
          }) ?? false;
          if (ok === 'ok') ok = true;
        } catch (err) {
          ok = err instanceof ConnectError ? err.message : String(err);
        }
        if (typeof ok === 'string') {
          attention = true;
          reasons.push(ok);
          parts[edit.part] = false;
        } else {
          parts[edit.part] = (parts[edit.part] ?? true) && ok;
        }
      }
      const values = Object.values(parts);
      const all = values.length > 0 && values.every(Boolean);
      // The hook script is shared: another tool having installed it does not make this one partly connected.
      const none = Object.entries(parts).every(([part, v]) => !v || sharedParts.has(part));
      if (attention) return { status: 'needs-attention', reasons, parts };
      if (all) return { status: 'connected', reasons: spec.afterApply ?? [], parts };
      if (none) return { status: 'not-connected', reasons: [], parts };
      return { status: 'partial', reasons: Object.entries(parts).filter(([, v]) => !v).map(([k]) => `${k} is not set up`), parts };
    },

    async plan(env, options) {
      return computePlan(spec, env, optionsFor(env, spec.id, options))
        .filter((p) => p.after !== p.before)
        .map((p) => toChange(p.file, p.before, p.after, p.summary));
    },

    async apply(env, options) {
      const opts = optionsFor(env, spec.id, options);
      // Compute everything first: one unreadable file means nothing is written at all.
      const plan = computePlan(spec, env, opts);
      const state = readState(env);
      const record: ToolRecord = state.tools[spec.id] ?? { applied_at: '', options: {}, files: {} };
      const changes: Change[] = [];
      for (const { file: path, before, after, mode, shared, summary } of plan) {
        if (after === before) {
          // Already in place (another tool installed the shared hook script): note the use so undo keeps it for them.
          if (shared && after !== null && !record.files[path]) record.files[path] = { created: false, written: sha256(after), restore: false };
          continue;
        }
        const prior = record.files[path];
        const unchanged = prior !== undefined && prior.written === (before === null ? '' : sha256(before));
        let file: FileRecord;
        if (unchanged) {
          // Re-applying over our own untouched write: keep the original backup so undo still restores the original.
          file = { ...prior };
        } else {
          const backupPath = before !== null ? backup(path, env.now()) : undefined;
          // The first write restores byte for byte on undo. A re-apply over a file someone edited since cannot:
          // its backup already holds OpenKT's older entries, so undo takes the entries out instead.
          file = { ...(backupPath ? { backup: backupPath } : {}), created: before === null, written: '', ...(prior ? { restore: false } : {}) };
        }
        if (after === null) removeFile(path);
        else writeAtomic(path, after, mode);
        record.files[path] = { ...file, written: after === null ? '' : sha256(after) };
        changes.push(toChange(path, before, after, summary));
      }
      record.applied_at = env.now().toISOString();
      record.options = opts;
      state.tools[spec.id] = record;
      writeState(env, state);
      return changes;
    },

    async undo(env) {
      const state = readState(env);
      const record = state.tools[spec.id];
      const othersUse = (file: string) => Object.entries(state.tools).some(([id, t]) => id !== spec.id && file in t.files);
      const changes: Change[] = [];
      for (const [path, edits] of groupByFile(spec.edits(env, optionsFor(env, spec.id)))) {
        if (edits.every((e) => e.shared) && othersUse(path)) continue;
        const current = readText(path);
        const rec = record?.files[path];
        let next: string | null;
        if (rec && rec.restore !== false && current !== null && sha256(current) === rec.written) {
          // Untouched since apply: put back exactly what was there.
          next = rec.created ? null : rec.backup ? readText(rec.backup) : current;
          if (next === current) next = edits.reduce<string | null>((cur, e) => wrapParse(path, () => e.remove(cur)), current);
        } else {
          next = edits.reduce<string | null>((cur, e) => wrapParse(path, () => e.remove(cur)), current);
        }
        if (next === current) continue;
        if (next === null) {
          removeFile(path);
          removeEmptyDirs(dirname(path), env.home);
        } else {
          writeAtomic(path, next);
        }
        changes.push(toChange(path, current, next, `removed: ${edits.map((e) => e.summary).join('; ')}`));
      }
      delete state.tools[spec.id];
      writeState(env, state);
      return changes;
    },
  };
}
