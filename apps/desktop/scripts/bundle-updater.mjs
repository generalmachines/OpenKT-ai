#!/usr/bin/env node
/**
 * After `tsc`: bundle electron-updater (+ its dependencies) into one CommonJS file the packaged main
 * process can `require` — the app's asar carries no node_modules for devDependencies. Only Developer ID
 * signed builds load it (src/main/update/signed.ts); ad-hoc builds use the verified self-update.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = createRequire(join(root, 'package.json')).resolve('electron-updater');
mkdirSync(join(root, 'dist-electron/vendor'), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: join(root, 'dist-electron/vendor/electron-updater.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});
console.log('bundled dist-electron/vendor/electron-updater.cjs');
