#!/usr/bin/env node
/**
 * Builds the macOS arm64 DMG + zip. electron-builder.yml is the UNSIGNED baseline
 * (identity: null, hardened runtime off). When signing secrets are present this script
 * switches to a Developer ID build with hardened runtime + notarisation — no code change:
 *   CSC_LINK, CSC_KEY_PASSWORD                       → sign
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID → notarise
 */
import { build, Platform, Arch } from 'electron-builder';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = yaml.load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'));
// electron is hoisted to the workspace root, where electron-builder cannot infer its version.
config.electronVersion = createRequire(import.meta.url)('electron/package.json').version;
// In-app updates: the update-smoke payload (version N+1) is packaged into a second folder.
if (process.env.OPENKT_DIST_OUTPUT) config.directories = { ...config.directories, output: process.env.OPENKT_DIST_OUTPUT };
const signed = Boolean(process.env.CSC_LINK);
const notarize = signed && Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
if (signed) {
  delete config.mac.identity; // let electron-builder pick the Developer ID from CSC_LINK
  config.mac.hardenedRuntime = true;
  config.mac.notarize = notarize;
  config.dmg = { ...config.dmg, sign: false };
}
console.log(`packaging: ${signed ? 'SIGNED' : 'UNSIGNED (ad-hoc)'}${notarize ? ' + notarised' : ''}`);
const targets = Platform.MAC.createTarget((process.env.OPENKT_DIST_TARGETS || 'dmg,zip').split(','), Arch.arm64);
const artifacts = await build({ projectDir: root, targets, config, publish: 'never' });
console.log(artifacts.join('\n'));
