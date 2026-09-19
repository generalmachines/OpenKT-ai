#!/usr/bin/env node
/** Refreshes bytes / sha256 / revision in models.manifest.json from the Hugging Face API. Run by hand, commit the result. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = join(dirname(fileURLToPath(import.meta.url)), '../src/main/models/models.manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); };
for (const [id, m] of Object.entries(manifest.models)) {
  const info = await get(`https://huggingface.co/api/models/${m.repo}`);
  const tree = await get(`https://huggingface.co/api/models/${m.repo}/tree/${info.sha}`);
  const f = tree.find((t) => t.path === m.file);
  if (!f?.lfs?.oid) throw new Error(`${m.repo}/${m.file} not found or not LFS`);
  Object.assign(m, { revision: info.sha, bytes: f.size, sha256: f.lfs.oid });
  console.log(id, f.size, f.lfs.oid);
}
manifest.generatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
