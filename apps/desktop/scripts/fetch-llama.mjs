#!/usr/bin/env node
/**
 * Fetches the PINNED llama.cpp release (tag + sha256 in src/main/models/models.manifest.json)
 * and lays out `llama-server` + its shared libraries in resources/llama/, which
 * electron-builder ships as Contents/Resources/llama.
 *   node scripts/fetch-llama.mjs                 # macOS arm64 asset from the manifest
 *   node scripts/fetch-llama.mjs --asset <name> --sha256 <hex>   # another platform of the same tag (local dev)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'src/main/models/models.manifest.json'), 'utf8')).llama;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const asset = arg('--asset') ?? manifest.asset;
const sha256 = arg('--sha256') ?? (asset === manifest.asset ? manifest.sha256 : undefined);
const out = arg('--out') ?? join(root, 'resources/llama');
const url = `https://github.com/ggml-org/llama.cpp/releases/download/${manifest.tag}/${asset}`;

const stamp = join(out, '.llama-release.json');
if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).asset === asset && existsSync(join(out, 'llama-server'))) {
  console.log(`resources/llama already holds ${asset}`);
  process.exit(0);
}

console.log(`fetching ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
const buf = Buffer.from(await res.arrayBuffer());
const digest = createHash('sha256').update(buf).digest('hex');
if (sha256 && digest !== sha256) throw new Error(`sha256 mismatch for ${asset}: got ${digest}, pinned ${sha256}`);
if (!sha256) console.warn(`no pinned sha256 for ${asset}; got ${digest}`);

const tmp = mkdtempSync(join(tmpdir(), 'llama-'));
const archive = join(tmp, asset);
writeFileSync(archive, buf);
execFileSync('tar', ['-xzf', archive, '-C', tmp]);
const inner = readdirSync(tmp).map((n) => join(tmp, n)).find((p) => lstatSync(p).isDirectory());
if (!inner) throw new Error('archive held no directory');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Only the server and the libraries it loads. Symlinks (libllama.dylib → libllama.0.dylib) are
// dereferenced: electron-builder and DMG copies are not reliable with relative symlinks.
const keep = (n) => n === 'llama-server' || n === 'LICENSE' || /\.(dylib|so|metal)(\.|$)/.test(n) || /\.so\.\d/.test(n);
let count = 0;
for (const name of readdirSync(inner)) {
  if (!keep(name)) continue;
  copyFileSync(join(inner, name), join(out, name)); // follows symlinks
  count += 1;
}
chmodSync(join(out, 'llama-server'), 0o755);
writeFileSync(stamp, JSON.stringify({ tag: manifest.tag, asset, sha256: digest }, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log(`resources/llama: ${count} files from ${manifest.tag} (${digest})`);
