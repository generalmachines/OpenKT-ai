import { describe, expect, it } from 'vitest';
import { compareOsVersion, compareSemver, parseSemver } from '../../../src/main/update/semver';

describe('semver', () => {
  it('orders CI builds numerically, not as strings', () => {
    expect(compareSemver('0.3.10', '0.3.9')).toBe(1);
    expect(compareSemver('0.3.128', '0.3.1280')).toBe(-1);
    expect(compareSemver('0.3.5', '0.3.5')).toBe(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });

  it('puts a pre-release before its release, and the dev build before every CI build', () => {
    expect(compareSemver('0.3.0-dev.0', '0.3.0')).toBe(-1);
    expect(compareSemver('0.3.0-dev.0', '0.3.1')).toBe(-1);
    expect(compareSemver('0.3.0-beta.2', '0.3.0-beta.10')).toBe(-1);
    expect(compareSemver('0.3.0-alpha', '0.3.0-alpha.1')).toBe(-1);
    expect(compareSemver('0.3.0-1', '0.3.0-alpha')).toBe(-1);
  });

  it('ignores build metadata', () => {
    expect(compareSemver('0.3.7+abc', '0.3.7')).toBe(0);
  });

  it('rejects what is not semver', () => {
    for (const v of ['', '0.3', 'v0.3.1', '0.3.01', '0.3.1.2', '../0.3.1', '0.3.1 ', 42, null]) expect(parseSemver(v)).toBeNull();
    expect(() => compareSemver('0.3', '0.3.1')).toThrow();
  });

  it('compares macOS versions with missing parts as zero', () => {
    expect(compareOsVersion('13.3', '13.3.0')).toBe(0);
    expect(compareOsVersion('14.0', '13.3')).toBe(1);
    expect(compareOsVersion('13.2.1', '13.3')).toBe(-1);
  });
});
