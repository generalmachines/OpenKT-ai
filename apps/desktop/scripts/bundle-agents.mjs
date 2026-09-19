#!/usr/bin/env node
/**
 * After `tsc`: (1) bundle the ESM workspace package @openkt/agents (+ ajv) into one CommonJS
 * file the packaged main process can `require` — no node_modules resolution inside the asar;
 * (2) copy models.manifest.json next to the compiled manifest.js.
 * esbuild comes from the lockfile (vite's dependency tree).
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, '../../packages/agents/dist/index.js');
if (!existsSync(entry)) throw new Error('packages/agents is not built: run `npm run build -w @openkt/agents` first');
mkdirSync(join(root, 'dist-electron/vendor'), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: join(root, 'dist-electron/vendor/openkt-agents.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});
cpSync(join(root, 'src/main/models/models.manifest.json'), join(root, 'dist-electron/main/models/models.manifest.json'));
console.log('bundled dist-electron/vendor/openkt-agents.cjs; copied models.manifest.json');
