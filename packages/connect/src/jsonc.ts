/**
 * A small format-preserving JSON editor. Edits change only the bytes of the member or item they touch, so a person's
 * settings file keeps its layout, key order and comments everywhere else. Reads JSON with comments and trailing
 * commas (VS Code, Cursor, Gemini CLI and Claude Code files may contain them). No dependencies.
 */

export class JsoncSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number, text: string) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const col = offset - before.lastIndexOf('\n');
    super(`${message} at line ${line}, column ${col}`);
    this.name = 'JsoncSyntaxError';
    this.offset = offset;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Entry {
  /** Where the entry starts: the key of a member, or the first character of an item. */
  start: number;
  key?: string;
  value: Node;
}

interface Node {
  kind: 'object' | 'array' | 'scalar';
  start: number;
  /** One past the last character. */
  end: number;
  entries: Entry[];
  value: Json;
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parseDocument(): Node | null {
    this.ws();
    if (this.i >= this.s.length) return null;
    const node = this.value();
    this.ws();
    if (this.i < this.s.length) this.fail('Unexpected content after the end of the document');
    return node;
  }

  private fail(msg: string): never {
    throw new JsoncSyntaxError(msg, this.i, this.s);
  }

  private ws(): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
        this.i++;
      } else if (c === '/' && s[this.i + 1] === '/') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (c === '/' && s[this.i + 1] === '*') {
        const close = s.indexOf('*/', this.i + 2);
        if (close < 0) this.fail('Unterminated comment');
        this.i = close + 2;
      } else {
        return;
      }
    }
  }

  private value(): Node {
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') {
      const start = this.i;
      const str = this.string();
      return { kind: 'scalar', start, end: this.i, entries: [], value: str };
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.fail(c === undefined ? 'Unexpected end of file' : `Unexpected character ${JSON.stringify(c)}`);
    const start = this.i;
    this.i += m[0].length;
    return { kind: 'scalar', start, end: this.i, entries: [], value: JSON.parse(m[0]) as Json };
  }

  private string(): string {
    const start = this.i;
    this.i++;
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') this.i += 2;
      else if (c === '"') {
        this.i++;
        try {
          return JSON.parse(s.slice(start, this.i)) as string;
        } catch {
          this.i = start;
          this.fail('Invalid string');
        }
      } else if (c === '\n') this.fail('Unterminated string');
      else this.i++;
    }
    this.fail('Unterminated string');
  }

  private object(): Node {
    const start = this.i;
    this.i++;
    const entries: Entry[] = [];
    const value: { [key: string]: Json } = {};
    this.ws();
    while (this.s[this.i] !== '}') {
      if (this.s[this.i] !== '"') this.fail('Expected a property name');
      const keyStart = this.i;
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail('Expected ":"');
      this.i++;
      this.ws();
      const v = this.value();
      entries.push({ start: keyStart, key, value: v });
      value[key] = v.value;
      this.ws();
      if (this.s[this.i] === ',') {
        this.i++;
        this.ws();
      } else if (this.s[this.i] !== '}') this.fail('Expected "," or "}"');
    }
    this.i++;
    return { kind: 'object', start, end: this.i, entries, value };
  }

  private array(): Node {
    const start = this.i;
    this.i++;
    const entries: Entry[] = [];
    const value: Json[] = [];
    this.ws();
    while (this.s[this.i] !== ']') {
      const v = this.value();
      entries.push({ start: v.start, value: v });
      value.push(v.value);
      this.ws();
      if (this.s[this.i] === ',') {
        this.i++;
        this.ws();
      } else if (this.s[this.i] !== ']') this.fail('Expected "," or "]"');
    }
    this.i++;
    return { kind: 'array', start, end: this.i, entries, value };
  }
}

function parseTree(text: string): Node | null {
  return new Parser(text).parseDocument();
}

/** Parse JSON with comments. Blank text → undefined. Throws JsoncSyntaxError. */
export function parseJsonc(text: string): unknown {
  const node = parseTree(text);
  return node ? node.value : undefined;
}

function detectUnit(text: string): string {
  const m = /\n([ \t]+)["\]}{[]/.exec(text);
  if (!m?.[1]) return '  ';
  return m[1].startsWith('\t') ? '\t' : m[1];
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** True when nothing but whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, offset));
}

function serialize(value: unknown, unit: string, base: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`\n${base}`);
}

function childIndent(text: string, node: Node, unit: string): string {
  const first = node.entries[0];
  if (first && startsLine(text, first.start)) return lineIndent(text, first.start);
  return lineIndent(text, node.start) + unit;
}

function find(node: Node, key: string): Entry | undefined {
  return node.entries.find((e) => e.key === key);
}

function insertEntry(text: string, node: Node, entryText: (indent: string) => string, unit: string): string {
  const indent = childIndent(text, node, unit);
  const last = node.entries[node.entries.length - 1];
  if (last) {
    const at = last.value.end;
    return `${text.slice(0, at)},\n${indent}${entryText(indent)}${text.slice(at)}`;
  }
  const close = lineIndent(text, node.start);
  return `${text.slice(0, node.start + 1)}\n${indent}${entryText(indent)}\n${close}${text.slice(node.end - 1)}`;
}

function removeEntry(text: string, node: Node, index: number): string {
  const entry = node.entries[index];
  if (!entry) return text;
  if (node.entries.length === 1) return `${text.slice(0, node.start + 1)}${text.slice(node.end - 1)}`;
  const next = node.entries[index + 1];
  if (next) return text.slice(0, entry.start) + text.slice(next.start);
  const prev = node.entries[index - 1]!;
  return text.slice(0, prev.value.end) + text.slice(entry.value.end);
}

function nest(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

function rootObject(text: string): Node {
  const root = parseTree(text);
  if (!root || root.kind !== 'object') throw new JsoncSyntaxError('The document is not a JSON object', 0, text);
  return root;
}

/** Set `path` to `value`, creating parent objects as needed. Blank text → a new document. */
export function setMember(text: string, path: string[], value: unknown): string {
  if (!text.trim()) return `${serialize(nest(path, value), '  ', '')}\n`;
  const unit = detectUnit(text);
  let node = rootObject(text);
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const entry = find(node, key);
    const rest = path.slice(i + 1);
    if (!entry) {
      return insertEntry(text, node, (indent) => `${JSON.stringify(key)}: ${serialize(nest(rest, value), unit, indent)}`, unit);
    }
    if (rest.length === 0 || entry.value.kind !== 'object') {
      return text.slice(0, entry.value.start) + serialize(nest(rest, value), unit, lineIndent(text, entry.start)) + text.slice(entry.value.end);
    }
    node = entry.value;
  }
  return text;
}

/** Remove the member at `path` (and its comma). Missing → text unchanged. */
export function removeMember(text: string, path: string[]): string {
  if (!text.trim() || path.length === 0) return text;
  let node = rootObject(text);
  for (let i = 0; i < path.length - 1; i++) {
    const entry = find(node, path[i]!);
    if (!entry || entry.value.kind !== 'object') return text;
    node = entry.value;
  }
  const index = node.entries.findIndex((e) => e.key === path[path.length - 1]);
  return index < 0 ? text : removeEntry(text, node, index);
}

/** Append `value` to the array at `path`, creating it (and its parents) if missing. */
export function appendItem(text: string, path: string[], value: unknown): string {
  if (!text.trim()) return setMember(text, path, [value]);
  const unit = detectUnit(text);
  let node = rootObject(text);
  for (let i = 0; i < path.length; i++) {
    const entry = find(node, path[i]!);
    if (!entry) return setMember(text, path, [value]);
    node = entry.value;
  }
  if (node.kind !== 'array') throw new JsoncSyntaxError(`${path.join('.')} is not an array`, node.start, text);
  return insertEntry(text, node, (indent) => serialize(value, unit, indent), unit);
}

/** Remove every item of the array at `path` for which `match` is true. Returns the text unchanged when none match. */
export function removeItems(text: string, path: string[], match: (item: unknown) => boolean): string {
  if (!text.trim()) return text;
  let out = text;
  for (;;) {
    let node: Node | undefined = rootObject(out);
    for (const key of path) {
      const entry: Entry | undefined = find(node, key);
      node = entry?.value;
      if (!node) return out;
    }
    if (node.kind !== 'array') return out;
    const index = node.entries.findIndex((e) => match(e.value.value));
    if (index < 0) return out;
    out = removeEntry(out, node, index);
  }
}

/** The value at `path`, or undefined. */
export function getAt(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
