import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { defaultSpaceId, isSlugTaken, joinCodeFrom, lastSpaceId, nextFreeSlug, rememberSpace, SLUG_RE, slugWithSuffix, spaceSlug } from './spaces';
import type { Space } from './types';

const space = (id: string, extra: Partial<Space> = {}): Space => ({
  id,
  name: id,
  slug: id,
  description: '',
  memberCount: 1,
  pageCount: 0,
  sessionCount: 0,
  updatedAt: '2026-09-19T10:00:00Z',
  ...extra,
});

describe('spaceSlug', () => {
  it.each([
    ['Q4 launch', 'q4-launch'],
    ['Northgate — pricing & people', 'northgate-pricing-people'],
    ['  Café Crème  ', 'cafe-creme'],
    ['A', 'a-space'],
    ['チーム', 'space'],
    ['---', 'space'],
  ])('%s → %s', (name, slug) => {
    expect(spaceSlug(name)).toBe(slug);
    expect(SLUG_RE.test(slug)).toBe(true);
  });

  it('keeps 41 characters and cuts the 42nd, never ending on a dash', () => {
    const exactly41 = 'a'.repeat(41);
    expect(spaceSlug(exactly41)).toBe(exactly41);
    expect(spaceSlug(`${exactly41}b`)).toBe(exactly41);
    // character 41 is a space → the cut would end on "-": it is trimmed
    expect(spaceSlug(`${'b'.repeat(40)} c`)).toBe('b'.repeat(40));
  });
});

describe('suffixes', () => {
  it('-2, -3… and the whole stays within 41 characters', () => {
    expect(slugWithSuffix('launch', 1)).toBe('launch');
    expect(slugWithSuffix('launch', 2)).toBe('launch-2');
    const long = 'x'.repeat(41);
    expect(slugWithSuffix(long, 2)).toBe(`${'x'.repeat(39)}-2`);
    expect(slugWithSuffix(long, 10)).toBe(`${'x'.repeat(38)}-10`);
    expect(slugWithSuffix(long, 10)).toHaveLength(41);
    expect(SLUG_RE.test(slugWithSuffix(long, 10))).toBe(true);
  });

  it('the next free one skips what is taken', () => {
    expect(nextFreeSlug('ops', new Set())).toEqual({ slug: 'ops', n: 1 });
    expect(nextFreeSlug('ops', new Set(['ops', 'ops-2']))).toEqual({ slug: 'ops-3', n: 3 });
    expect(nextFreeSlug('ops', new Set(['ops-5']), 5)).toEqual({ slug: 'ops-6', n: 6 });
  });

  it('a 409, or the server’s 400 “slug already exists”, means taken; other errors do not', () => {
    expect(isSlugTaken(new ApiError('conflict', 'x', 409))).toBe(true);
    expect(isSlugTaken(new ApiError('invalid', 'project slug already exists', 400, 'validation_error'))).toBe(true);
    expect(isSlugTaken(new ApiError('invalid', 'invalid request payload', 400, 'validation_error'))).toBe(false);
    expect(isSlugTaken(new ApiError('forbidden', 'nope', 403))).toBe(false);
    expect(isSlugTaken(new Error('slug already exists'))).toBe(false);
  });
});

describe('joinCodeFrom', () => {
  it.each([
    ['https://openkt.ai/join/k3xQ9a', 'k3xQ9a'],
    ['  https://api.openkt.ai/v1/join/k3xQ9a?utm=x  ', 'k3xQ9a'],
    ['openkt://join/k3xQ9a', 'k3xQ9a'],
    ['https://openkt.ai/invite?code=k3xQ9a', 'k3xQ9a'],
    ['k3xQ9a', 'k3xQ9a'],
    ['', ''],
    ['not a code', ''],
    ['abc', ''],
  ])('%j → %j', (input, code) => expect(joinCodeFrom(input)).toBe(code));
});

describe('the space a save goes into', () => {
  beforeEach(() => localStorage.clear());
  const spaces = [space('team'), space('mine', { personal: true }), space('theirs', { myRole: 'reader' })];

  it('Personal when nothing is remembered', () => {
    expect(lastSpaceId()).toBe('');
    expect(defaultSpaceId(spaces)).toBe('mine');
  });

  it('the one saved into last, while it is still there and writable', () => {
    rememberSpace('team');
    expect(lastSpaceId()).toBe('team');
    expect(defaultSpaceId(spaces)).toBe('team');
    expect(defaultSpaceId(spaces.filter((s) => s.id !== 'team'))).toBe('mine');
    rememberSpace('theirs'); // a reader cannot save there
    expect(defaultSpaceId(spaces)).toBe('mine');
  });
});
