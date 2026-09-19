/**
 * What a downloaded update has to prove before it is allowed anywhere near /Applications:
 * it is OUR bundle (CFBundleIdentifier), it is the version the feed promised
 * (CFBundleShortVersionString) and its code signature is intact (`codesign --verify --deep --strict`;
 * an ad-hoc signature passes, a tampered or unsigned bundle does not).
 * Every tool is called by absolute path; tests inject fake tools found on PATH.
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Tools {
  plutil: string;
  codesign: string;
  ditto: string;
  xattr: string;
  open: string;
  sh: string;
}

export const SYSTEM_TOOLS: Tools = { plutil: '/usr/bin/plutil', codesign: '/usr/bin/codesign', ditto: '/usr/bin/ditto', xattr: '/usr/bin/xattr', open: '/usr/bin/open', sh: '/bin/sh' };

export class BundleError extends Error {
  constructor(readonly code: 'unzip_failed' | 'no_bundle' | 'wrong_bundle' | 'wrong_version' | 'bad_signature', message: string) {
    super(message);
  }
}

async function exec(bin: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  const r = await run(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr };
}

/** `ditto -x -k zip dir`: the archive the release job produced expands to `<dir>/OpenKT.app`. */
export async function unzipBundle(zipPath: string, dir: string, tools: Tools = SYSTEM_TOOLS): Promise<string> {
  try {
    await exec(tools.ditto, ['-x', '-k', zipPath, dir], 300_000);
  } catch (e) {
    throw new BundleError('unzip_failed', `could not expand the update: ${(e as Error).message}`);
  }
  const entries = (await readdir(dir)).filter((n) => n.endsWith('.app'));
  if (entries.length !== 1) throw new BundleError('no_bundle', `the update contains ${entries.length} app bundles, expected exactly one`);
  const app = join(dir, entries[0]!);
  if (!(await stat(join(app, 'Contents', 'Info.plist'))).isFile()) throw new BundleError('no_bundle', 'the update has no Info.plist');
  return app;
}

export async function plistValue(plist: string, key: string, tools: Tools = SYSTEM_TOOLS): Promise<string> {
  const { stdout } = await exec(tools.plutil, ['-extract', key, 'raw', '-o', '-', plist], 20_000);
  return stdout.trim();
}

export interface Expected {
  bundleId: string;
  version: string;
  /** The running app's TeamIdentifier. When it has one (Developer ID), the update must carry the same one. */
  teamId?: string | null;
}

export async function verifyBundle(appPath: string, expected: Expected, tools: Tools = SYSTEM_TOOLS): Promise<void> {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const id = await plistValue(plist, 'CFBundleIdentifier', tools).catch(() => '');
  if (id !== expected.bundleId) throw new BundleError('wrong_bundle', `the update is "${id || 'unknown'}", not ${expected.bundleId}`);
  const version = await plistValue(plist, 'CFBundleShortVersionString', tools).catch(() => '');
  if (version !== expected.version) throw new BundleError('wrong_version', `the update says it is ${version || 'unknown'}, the feed promised ${expected.version}`);
  try {
    await exec(tools.codesign, ['--verify', '--deep', '--strict', appPath], 300_000);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new BundleError('bad_signature', `the update's code signature does not verify: ${(err.stderr || err.message).trim().split('\n')[0]}`);
  }
  if (expected.teamId) {
    const team = await teamIdentifier(appPath, tools);
    if (team !== expected.teamId) throw new BundleError('bad_signature', `the update is signed by ${team ?? 'nobody'}, this app by ${expected.teamId}`);
  }
}

/** The zip came from the network: without this, Gatekeeper would treat the new copy as a fresh unsigned download. */
export async function stripQuarantine(path: string, tools: Tools = SYSTEM_TOOLS): Promise<void> {
  await exec(tools.xattr, ['-dr', 'com.apple.quarantine', path], 120_000).catch(() => undefined);
}

/** `codesign -dv` prints `TeamIdentifier=ABCDE12345` for Developer ID builds and `TeamIdentifier=not set` for ad-hoc ones. */
export async function teamIdentifier(appPath: string, tools: Tools = SYSTEM_TOOLS): Promise<string | null> {
  try {
    const r = await run(tools.codesign, ['-dv', '--verbose=2', appPath], { timeout: 20_000, encoding: 'utf8' });
    return parseTeamIdentifier(`${r.stdout}\n${r.stderr}`);
  } catch (e) {
    return parseTeamIdentifier(String((e as { stderr?: string }).stderr ?? ''));
  }
}

export function parseTeamIdentifier(output: string): string | null {
  const m = /^TeamIdentifier=(.+)$/m.exec(output);
  const v = m?.[1]?.trim();
  return v && v !== 'not set' ? v : null;
}
