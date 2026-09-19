#!/usr/bin/env node
/**
 * CI only (never committed): gives the build its release version and build info before packaging.
 *   node scripts/stamp-version.mjs 0.3.128
 * Writes apps/desktop/package.json `version` (→ CFBundleShortVersionString, app.getVersion()) and
 * `openktBuild` {commit, builtAt, channel, signed}, read by src/main/update/ipc.ts for Settings → About.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`usage: stamp-version.mjs <major.minor.patch> (got "${version}")`);
const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(path, 'utf8'));
pkg.version = version;
pkg.openktBuild = {
  commit: process.env.GITHUB_SHA ?? '',
  builtAt: new Date().toISOString(),
  channel: process.env.OPENKT_CHANNEL || 'stable',
  signed: Boolean(process.env.CSC_LINK || process.env.CSC_LINK_SECRET),
};
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`stamped ${pkg.name} ${version} (${pkg.openktBuild.commit.slice(0, 7) || 'no commit'}, ${pkg.openktBuild.signed ? 'signed' : 'ad-hoc'})`);
