/**
 * What makes a set of files a skill. Pure: the editor uses it for live
 * validation, the mock adapter to answer like the server, and the screens to
 * turn the server's 422 codes into sentences.
 *
 * A skill is a folder of text files. `SKILL.md` must exist and must open with
 * a frontmatter block that has a `name` and a `description`:
 *
 *   ---
 *   name: sharpen-marketing-message
 *   description: Rewrite a marketing draft in our voice. Use when …
 *   ---
 */
import { ApiError } from './errors';
import type { SkillFile, SkillFileInput } from './types';

export const SKILL_MD = 'SKILL.md';
export const MAX_FILE_BYTES = 200_000;
export const MAX_FILES = 50;
export const TEXT_EXTENSIONS = ['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'py', 'js', 'ts', 'sh', 'html', 'css', 'xml', 'toml'] as const;

export const SKILL_ERROR_CODES = ['invalid_frontmatter', 'missing_skill_md', 'file_too_large', 'too_many_files', 'bad_path'] as const;
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

export const FRONTMATTER_EXAMPLE = '---\nname: my-skill\ndescription: What it does, and when to use it.\n---';

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1000).toFixed(1)} KB`;
}

export const toSkillFile = (f: SkillFileInput): SkillFile => ({ path: f.path, content: f.content, bytes: byteLength(f.content) });

/** "Sharpen a marketing message" → "sharpen-a-marketing-message" */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'untitled-skill';
}

/** What a new skill starts with when nobody supplies files. */
export function starterSkillMd(title: string): string {
  const name = title.trim() || 'Untitled skill';
  return `---
name: ${slugify(name)}
description: Say what this skill does, and when someone should use it.
---

# ${name}

Write the instructions the way you would brief a new teammate.

## When to use it
- The kind of request this skill is for.

## Steps
1. The first thing to do.
2. The next thing.
3. What a good result looks like.
`;
}

// ── frontmatter ─────────────────────────────────────────────────────────

export interface Frontmatter {
  /** Every `key: value` line of the block, in order. */
  fields: { key: string; value: string }[];
  name: string;
  description: string;
  /** The text after the closing `---`. */
  body: string;
}

const unquote = (v: string): string => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

/**
 * Reads the block between the first two `---` lines. Deliberately small: flat
 * `key: value` pairs, with `>`/`|` and indented continuation lines folded into
 * the value. Returns null when the file does not open with a block.
 */
export function parseFrontmatter(source: string): Frontmatter | null {
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const fields: { key: string; value: string }[] = [];
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) fields.push({ key: m[1]!, value: /^[>|][+-]?$/.test(m[2]!.trim()) ? '' : unquote(m[2]!) });
    else if (/^\s+\S/.test(line) && fields.length) {
      const last = fields[fields.length - 1]!;
      last.value = `${last.value} ${line.trim()}`.trim();
    }
  }
  const get = (key: string) => fields.find((f) => f.key === key)?.value ?? '';
  return {
    fields,
    name: get('name'),
    description: get('description'),
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
  };
}

/** One friendly sentence when SKILL.md would be refused, or null when it is fine. */
export function frontmatterProblem(source: string): string | null {
  const fm = parseFrontmatter(source);
  if (!fm) return 'The first lines need a name and a description, like this:';
  if (!fm.name && !fm.description) return 'The block at the top needs a name and a description, like this:';
  if (!fm.name) return 'The block at the top is missing its name — a short label in lowercase with hyphens, like this:';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fm.name)) return 'The name can only use lowercase letters, numbers and hyphens (64 at most), like this:';
  if (!fm.description) return 'The block at the top is missing its description — one or two sentences on what the skill does and when to use it, like this:';
  if (fm.description.length > 1024) return 'The description is too long. Keep it under 1,024 characters — the detail belongs below the block.';
  return null;
}

// ── paths ───────────────────────────────────────────────────────────────

/** One friendly sentence when the path would be refused, or null. `others` are the paths already taken. */
export function pathProblem(path: string, others: readonly string[] = []): string | null {
  const p = path.trim();
  if (!p) return 'Give the file a name, like references/examples.md.';
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return 'Use a path inside the skill, like references/examples.md — not one that starts from the disk.';
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.')) return 'A path can’t use “..” — files stay inside the skill.';
  if (parts.some((s) => !s)) return 'That path has an empty folder name in it. Check the slashes.';
  if (!/^[\w./ -]+$/.test(p) || p.length > 200) return 'Use letters, numbers, dots, hyphens and underscores in file names.';
  const ext = /\.([A-Za-z0-9]+)$/.exec(parts[parts.length - 1]!)?.[1]?.toLowerCase();
  if (!ext || !(TEXT_EXTENSIONS as readonly string[]).includes(ext)) return `Skills hold text files. End the name with one of: ${TEXT_EXTENSIONS.slice(0, 6).map((e) => `.${e}`).join(', ')}…`;
  if (others.some((o) => o.toLowerCase() === p.toLowerCase())) return 'There is already a file with that name.';
  return null;
}

/** The first thing the server would refuse, with its code; null when the set is a valid skill. */
export function filesProblem(files: readonly SkillFileInput[]): { code: SkillErrorCode; message: string } | null {
  if (files.length > MAX_FILES) return { code: 'too_many_files', message: describeSkillErrorCode('too_many_files') };
  const seen: string[] = [];
  for (const f of files) {
    if (pathProblem(f.path, seen)) return { code: 'bad_path', message: `${f.path}: ${pathProblem(f.path, seen)}` };
    seen.push(f.path);
    if (byteLength(f.content) > MAX_FILE_BYTES) return { code: 'file_too_large', message: `${f.path} is too large. ${describeSkillErrorCode('file_too_large')}` };
  }
  const main = files.find((f) => f.path === SKILL_MD);
  if (!main) return { code: 'missing_skill_md', message: describeSkillErrorCode('missing_skill_md') };
  if (frontmatterProblem(main.content)) return { code: 'invalid_frontmatter', message: describeSkillErrorCode('invalid_frontmatter') };
  return null;
}

export function describeSkillErrorCode(code: SkillErrorCode): string {
  switch (code) {
    case 'invalid_frontmatter':
      return 'SKILL.md needs to open with a name and a description between two --- lines.';
    case 'missing_skill_md':
      return 'Every skill needs a SKILL.md file. It can’t be removed or renamed.';
    case 'file_too_large':
      return `A file in a skill can be ${formatBytes(MAX_FILE_BYTES)} at most. Move long material into a second file.`;
    case 'too_many_files':
      return `A skill can hold ${MAX_FILES} files at most. Remove some and save again.`;
    case 'bad_path':
      return 'One of the file names isn’t allowed. Use a path inside the skill, like references/examples.md.';
  }
}

/** A sentence for anything a skill call can throw. Falls back to `fallback` for errors that are not about the files. */
export function describeSkillError(e: unknown, fallback: (e: unknown) => string): string {
  if (e instanceof ApiError && (SKILL_ERROR_CODES as readonly string[]).includes(e.code)) return describeSkillErrorCode(e.code as SkillErrorCode);
  return fallback(e);
}

export const isVersionConflict = (e: unknown): boolean => e instanceof ApiError && e.kind === 'conflict';
