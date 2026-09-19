import { describe, expect, it } from 'vitest';
import { appendItem, JsoncSyntaxError, parseJsonc, removeItems, removeMember, setMember } from '../src/jsonc.js';

describe('jsonc', () => {
  it('parses comments and trailing commas, and reports where a syntax error is', () => {
    expect(parseJsonc('{\n // c\n "a": [1, 2,], /* b */ "b": {"c": null},\n}')).toEqual({ a: [1, 2], b: { c: null } });
    expect(parseJsonc('  ')).toBeUndefined();
    expect(() => parseJsonc('{\n  "a": 1,\n  "b": \n}')).toThrow(/line 4/);
    expect(() => parseJsonc('{"a": "unterminated}')).toThrow(JsoncSyntaxError);
  });

  it('adds a member without touching the rest, following the file’s indentation', () => {
    const src = '{\n    "keep":   [1,2,3],\n    "obj": {"x": 1}\n}\n';
    const out = setMember(src, ['obj', 'y'], { deep: true });
    expect(out).toBe('{\n    "keep":   [1,2,3],\n    "obj": {"x": 1,\n        "y": {\n            "deep": true\n        }}\n}\n');
    expect(parseJsonc(out)).toEqual({ keep: [1, 2, 3], obj: { x: 1, y: { deep: true } } });
  });

  it('creates missing parents, fills empty objects and starts blank files', () => {
    expect(setMember('', ['a', 'b'], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
    expect(setMember('{}', ['a'], 1)).toBe('{\n  "a": 1\n}');
    expect(parseJsonc(setMember('{"x": {}}', ['x', 'y', 'z'], [1]))).toEqual({ x: { y: { z: [1] } } });
  });

  it('replaces an existing value in place', () => {
    expect(setMember('{"a": 1, "b": {"old": true}, "c": 3}', ['b'], 'new')).toBe('{"a": 1, "b": "new", "c": 3}');
  });

  it('removes a member and its comma wherever it sits', () => {
    const src = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
    expect(removeMember(src, ['a'])).toBe('{\n  "b": 2,\n  "c": 3\n}');
    expect(removeMember(src, ['b'])).toBe('{\n  "a": 1,\n  "c": 3\n}');
    expect(removeMember(src, ['c'])).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(removeMember('{"only": 1}', ['only'])).toBe('{}');
    expect(removeMember(src, ['missing'])).toBe(src);
  });

  it('appends to and removes from arrays, and round-trips', () => {
    const src = '{\n  "list": [\n    {"id": 1}\n  ]\n}\n';
    const added = appendItem(src, ['list'], { id: 2 });
    expect(parseJsonc(added)).toEqual({ list: [{ id: 1 }, { id: 2 }] });
    expect(removeItems(added, ['list'], (v) => (v as { id: number }).id === 2)).toBe(src);
    expect(parseJsonc(appendItem('{}', ['new', 'list'], 'x'))).toEqual({ new: { list: ['x'] } });
  });

  it('refuses documents that are not objects', () => {
    expect(() => setMember('[1,2]', ['a'], 1)).toThrow(JsoncSyntaxError);
  });
});
