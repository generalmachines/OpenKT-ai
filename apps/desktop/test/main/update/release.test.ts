/** scripts/release-feed.mjs: the feed the release job writes must be one the app accepts. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { cleanNotes, makeFeed } from '../../../scripts/release-feed.mjs';
import { DEFAULT_FEED_URL, parseFeed } from '../../../src/main/update/feed';

describe('release notes', () => {
  it('keeps what a person would notice, in plain words, at most 10', () => {
    expect(
      cleanNotes([
        'feat(desktop): friendly sign-in — Welcome screen, accounts, share by email (#64)',
        'feat(desktop): Google sign-in in the system browser — loopback PKCE in main, auth.google IPC',
        'ci(desktop): capture-smoke runs llama.cpp on the CPU',
        'chore(desktop): tidy comment in live test',
        'pipeline: secrets filter — no false positive (J6b) (#65)',
        'server: built-in accounts — email + password',
        'fix(desktop): live contract test must skip cleanly',
        'Merge pull request #12 from x/y',
        'design: skill screens — open a skill, read its files',
        'fix: the sidebar no longer flickers (#70)',
        'fix: the sidebar no longer flickers',
      ]),
    ).toEqual(['Friendly sign-in — Welcome screen, accounts, share by email', 'Google sign-in in the system browser', 'Skill screens — open a skill, read its files', 'The sidebar no longer flickers']);
    expect(cleanNotes([...Array(20).keys()].map((i) => `feat: thing ${i}`))).toHaveLength(10);
  });
});

describe('makeFeed', () => {
  it('writes a latest.json the app accepts: pinned host, sha256 + sha512, sizes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkt-feed-'));
    try {
      writeFileSync(join(dir, 'a.zip'), 'zip-bytes');
      writeFileSync(join(dir, 'a.dmg'), 'dmg-bytes!');
      const base = DEFAULT_FEED_URL.replace(/\/latest\.json$/, '');
      const feed = await makeFeed({ version: '0.3.128', baseUrl: `${base}/`, commit: 'abc', zip: join(dir, 'a.zip'), dmg: join(dir, 'a.dmg'), subjects: ['feat: faster search'], minOs: '13.3', releasedAt: '2026-09-19T00:00:00Z' });
      expect(feed.files.zip.url).toBe(`${base}/releases/0.3.128/OpenKT-0.3.128-arm64.zip`);
      expect(feed.files.zip.size).toBe(9);
      expect(feed.files.zip.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(feed.files.zip.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      expect(feed.channel).toBe('stable');
      const parsed = parseFeed(JSON.parse(JSON.stringify(feed)), { url: DEFAULT_FEED_URL, allowLoopbackHttp: false });
      expect(parsed).toMatchObject({ version: '0.3.128', notes: ['Faster search'], min_os: '13.3', files: { zip: { size: 9, sha512: feed.files.zip.sha512 } } });
      await expect(makeFeed({ version: '0.3.128-dev.1', baseUrl: base, commit: 'x', zip: join(dir, 'a.zip'), dmg: join(dir, 'a.dmg'), subjects: [], minOs: '13.3' })).rejects.toThrow(/release version/);
      await expect(makeFeed({ version: '0.3.1', baseUrl: base.replace('https:', 'http:'), commit: 'x', zip: join(dir, 'a.zip'), dmg: join(dir, 'a.dmg'), subjects: [], minOs: '13.3' })).rejects.toThrow(/https/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
