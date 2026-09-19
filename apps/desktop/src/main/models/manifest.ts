/**
 * The model manifest: what to download, how big it is, and its sha256.
 * No `electron` import anywhere under models/ or local-ai/ except ipc.ts and
 * smoke.ts — the same modules run under plain Node in CI (scripts/smoke-local-ai.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelFile {
  /** Manifest key, e.g. "embed", "llm-4b". */
  id: string;
  repo: string;
  /** Pinned Hugging Face commit. */
  revision: string;
  file: string;
  /** Local file name when it differs from `file` (both mmproj files are called mmproj-F16.gguf). */
  saveAs?: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  models: Record<string, Omit<ModelFile, 'id'>>;
  llama: { tag: string; asset: string; url: string; bytes: number; sha256: string };
}

export type ModelRole = 'embed' | 'llm' | 'mmproj';
export type ModelPlan = Record<ModelRole, ModelFile>;

export function loadManifest(path = join(__dirname, 'models.manifest.json')): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export const GIB = 1024 ** 3;

/**
 * Macs with 8 GB of RAM or less get the 2B model. "8 GB" machines report
 * exactly 8 GiB from os.totalmem(), so the comparison is inclusive with a little slack.
 */
export function chooseTier(totalMemBytes: number): '2b' | '4b' {
  return totalMemBytes <= 8.5 * GIB ? '2b' : '4b';
}

function pick(manifest: Manifest, id: string): ModelFile {
  const m = manifest.models[id];
  if (!m) throw new Error(`models.manifest.json has no entry "${id}"`);
  return { id, ...m };
}

export function chooseModels(manifest: Manifest, totalMemBytes: number, forceTier?: '2b' | '4b'): ModelPlan {
  const tier = forceTier ?? chooseTier(totalMemBytes);
  return { embed: pick(manifest, 'embed'), llm: pick(manifest, `llm-${tier}`), mmproj: pick(manifest, `mmproj-${tier}`) };
}

export function localName(m: ModelFile): string {
  return m.saveAs ?? m.file;
}

export function modelUrl(m: ModelFile, base = 'https://huggingface.co'): string {
  return `${base}/${m.repo}/resolve/${m.revision}/${m.file}`;
}
