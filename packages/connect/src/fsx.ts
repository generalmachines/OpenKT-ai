import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Write through a temp file + rename so a crash never leaves half a config. Keeps the file's existing mode. */
export function writeAtomic(file: string, content: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  let keep: number | undefined = mode;
  if (keep === undefined && existsSync(file)) keep = statSync(file).mode & 0o777;
  const tmp = `${file}.openkt-tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: keep ?? 0o644 });
  if (keep !== undefined) chmodSync(tmp, keep);
  renameSync(tmp, file);
}

export function removeFile(file: string): void {
  rmSync(file, { force: true });
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

/** Copy `file` to `<file>.openkt-backup-<YYYYMMDD-HHMMSS>` (UTC; a counter is added if that name exists). */
export function backup(file: string, now: Date): string {
  const base = `${file}.openkt-backup-${stamp(now)}`;
  let target = base;
  for (let n = 2; existsSync(target); n++) target = `${base}-${n}`;
  copyFileSync(file, target);
  return target;
}
