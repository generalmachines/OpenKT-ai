#!/usr/bin/env node
/**
 * Refreshes bytes / sha256 / revision in models.manifest.json from the Hugging Face API, and each
 * model's licence from its original model card (`model`, shown to people before they download).
 * Run by hand, commit the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = join(dirname(fileURLToPath(import.meta.url)), '../src/main/models/models.manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const SPDX = { 'apache-2.0': 'Apache-2.0', mit: 'MIT' };
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); };
for (const [id, m] of Object.entries(manifest.models)) {
  const info = await get(`https://huggingface.co/api/models/${m.repo}`);
  const tree = await get(`https://huggingface.co/api/models/${m.repo}/tree/${info.sha}`);
  const f = tree.find((t) => t.path === m.file);
  if (!f?.lfs?.oid) throw new Error(`${m.repo}/${m.file} not found or not LFS`);
  Object.assign(m, { revision: info.sha, bytes: f.size, sha256: f.lfs.oid });
  if (!m.model) throw new Error(`${id}: set "model" (the original model card, e.g. Qwen/Qwen3.5-4B)`);
  const card = await get(`https://huggingface.co/api/models/${m.model}`);
  const lic = card.cardData?.license;
  if (!lic) throw new Error(`${m.model}: the model card states no licence`);
  m.license = SPDX[lic] ?? lic;
  console.log(id, f.size, f.lfs.oid, m.license);
}
manifest.generatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
