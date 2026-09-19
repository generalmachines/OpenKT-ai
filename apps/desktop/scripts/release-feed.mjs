#!/usr/bin/env node
/**
 * Writes desktop/latest.json for the release job (.github/workflows/desktop.yml → release).
 *
 *   node scripts/release-feed.mjs --version 0.3.128 --base-url https://…/desktop --commit <sha> \
 *     --zip OpenKT.zip --dmg OpenKT.dmg --subjects subjects.txt --min-os 13.3 > latest.json
 *
 * `notes` are the commit subjects since the previous release, cleaned for people: conventional-commit
 * prefixes, PR/task references and internal-only commits (ci, chore, test, build, docs, refactor) are dropped.
 * Pure Node, no dependencies: the release job runs it without `npm ci`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Commit types and scopes that never reach the people using the app. */
const INTERNAL = /^(ci|chore|test|tests|build|docs|refactor|style|perf|revert|wip|merge|deps|server|pipeline|infra|deploy|worker|release)$/i;
/** Subjects that read as engineering notes rather than changes a person would notice. */
const JARGON = /\b(CI|smoke|tests?|spec|lint|esbuild|refactor|bump|deps|typecheck|fixtures?|mock|IPC|PKCE|renderer|main-process|typing|packaging|proxy|adapter|schemas?|eval)\b|\w\(\)|^Spec\b/i;

/** "feat(desktop): friendly sign-in — Welcome screen (#64)" → "Friendly sign-in — Welcome screen" */
export function cleanNotes(subjects, max = 10) {
  const out = [];
  for (const raw of subjects) {
    let s = String(raw).trim();
    if (!s || /^Merge (pull request|branch)/.test(s)) continue;
    const m = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/i.exec(s);
    if (m) {
      if (INTERNAL.test(m[1]) || (m[2] && m[2].split(/[,/ ]+/).every((scope) => INTERNAL.test(scope)))) continue;
      s = m[3];
    }
    // "Google sign-in in the system browser — loopback PKCE in main, auth.google IPC": keep what a person sees.
    const [head, ...tail] = s.split(' — ');
    if (tail.length && JARGON.test(tail.join(' — '))) s = head;
    if (JARGON.test(s)) continue;
    s = s
      .replace(/\s*\((#\d+|[A-Z]{1,3}\d+[a-z]?)\)/g, '')
      .replace(/\s*\[[^\]]*\]\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) continue;
    s = s[0].toUpperCase() + s.slice(1);
    if (s.length > 160) s = `${s.slice(0, 157)}…`;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

async function digest(path, algo, enc) {
  const h = createHash(algo);
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest(enc);
}

export async function fileEntry(path, url) {
  return { url, sha256: await digest(path, 'sha256', 'hex'), sha512: await digest(path, 'sha512', 'base64'), size: statSync(path).size };
}

export async function makeFeed({ version, baseUrl, commit, zip, dmg, subjects, minOs, releasedAt = new Date().toISOString(), channel = 'stable' }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  const base = baseUrl.replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error(`base URL must be https: ${base}`);
  const dir = `${base}/releases/${version}`;
  return {
    version,
    channel,
    released_at: releasedAt,
    commit,
    notes: cleanNotes(subjects),
    min_os: minOs,
    files: {
      zip: await fileEntry(zip, `${dir}/OpenKT-${version}-arm64.zip`),
      dmg: await fileEntry(dmg, `${dir}/OpenKT-${version}-arm64.dmg`),
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  for (const k of ['version', 'base-url', 'commit', 'zip', 'dmg', 'min-os']) if (!args[k]) throw new Error(`missing --${k}`);
  const subjects = args.subjects ? readFileSync(args.subjects, 'utf8').split('\n') : [];
  const feed = await makeFeed({ version: args.version, baseUrl: args['base-url'], commit: args.commit, zip: args.zip, dmg: args.dmg, subjects, minOs: args['min-os'] });
  process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
  console.error(`latest.json for ${feed.version}: ${basename(args.zip)} ${feed.files.zip.size} bytes, ${feed.notes.length} notes`);
}
