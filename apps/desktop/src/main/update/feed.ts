/**
 * The release feed: one small JSON document (`desktop/latest.json`) written LAST by the release job.
 * Everything that comes out of it is validated here before any byte of an update is downloaded:
 * https only, no redirects, every URL on the feed's own host, a real semver, a sha256 and a size.
 */
import { compareOsVersion, compareSemver, parseSemver } from './semver';

export const DEFAULT_FEED_URL = 'https://openkt-downloads-724772068721.s3.ap-south-1.amazonaws.com/desktop/latest.json';
export const FEED_TIMEOUT_MS = 5000;
const FEED_MAX_BYTES = 64 * 1024;
/** The app is ~250 MB; anything past this is not an OpenKT release and would only fill the disk. */
const MAX_FILE_BYTES = 2 * 1024 ** 3;

export interface FeedConfig {
  url: string;
  /** Only ever true in the CI smoke run: http://127.0.0.1 is accepted as a feed host. */
  allowLoopbackHttp: boolean;
}

export interface FeedFile {
  url: string;
  sha256: string;
  /** Base64 sha512, used by electron-updater on signed builds. Optional. */
  sha512?: string;
  size: number;
}

export interface Feed {
  version: string;
  channel: string;
  released_at: string;
  commit: string;
  notes: string[];
  min_os: string;
  files: { zip: FeedFile; dmg?: FeedFile };
}

export class FeedError extends Error {
  /** `not_published`: the feed does not exist yet (S3 answers 403/404 for a missing key) — not an error for the user. */
  constructor(readonly code: 'bad_url' | 'fetch_failed' | 'not_published' | 'malformed' | 'wrong_host' | 'insecure', message: string) {
    super(message);
  }
}

/** OPENKT_UPDATE_FEED is honoured ONLY together with OPENKT_SMOKE=1 (the CI proof). Users cannot repoint the updater with an env var. */
export function resolveFeedConfig(env: Record<string, string | undefined>): FeedConfig {
  const override = env['OPENKT_UPDATE_FEED'];
  if (env['OPENKT_SMOKE'] === '1' && override) return { url: override, allowLoopbackHttp: true };
  return { url: DEFAULT_FEED_URL, allowLoopbackHttp: false };
}

function checkUrl(raw: unknown, config: FeedConfig, feedHost: string | null, what: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new FeedError('bad_url', `${what} is not a URL`);
  }
  const loopback = config.allowLoopbackHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) throw new FeedError('insecure', `${what} must be https`);
  if (url.username || url.password) throw new FeedError('bad_url', `${what} must not carry credentials`);
  if (feedHost !== null && url.host !== feedHost) throw new FeedError('wrong_host', `${what} is on ${url.host}, not on the update server ${feedHost}`);
  return url;
}

export function feedHost(config: FeedConfig): string {
  return checkUrl(config.url, config, null, 'the update feed').host;
}

function file(raw: unknown, config: FeedConfig, host: string, what: string): FeedFile {
  if (!raw || typeof raw !== 'object') throw new FeedError('malformed', `${what} is missing`);
  const j = raw as Record<string, unknown>;
  const url = checkUrl(j['url'], config, host, `${what} url`);
  const sha256 = typeof j['sha256'] === 'string' ? j['sha256'].toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new FeedError('malformed', `${what} has no sha256`);
  const size = j['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new FeedError('malformed', `${what} has no size`);
  if (size > MAX_FILE_BYTES) throw new FeedError('malformed', `${what} is implausibly large (${size} bytes)`);
  const sha512 = typeof j['sha512'] === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(j['sha512']) ? j['sha512'] : undefined;
  return { url: url.href, sha256, size, ...(sha512 ? { sha512 } : {}) };
}

/** Throws FeedError unless `raw` is a complete, well-formed feed whose files live on the feed's host. */
export function parseFeed(raw: unknown, config: FeedConfig): Feed {
  const host = feedHost(config);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FeedError('malformed', 'the update feed is not an object');
  const j = raw as Record<string, unknown>;
  const version = j['version'];
  if (typeof version !== 'string' || !parseSemver(version)) throw new FeedError('malformed', 'the update feed has no valid version');
  const files = j['files'];
  if (!files || typeof files !== 'object') throw new FeedError('malformed', 'the update feed lists no files');
  const f = files as Record<string, unknown>;
  const notes = Array.isArray(j['notes']) ? j['notes'] : typeof j['notes'] === 'string' ? j['notes'].split('\n') : [];
  return {
    version,
    channel: typeof j['channel'] === 'string' && j['channel'] ? j['channel'] : 'stable',
    released_at: typeof j['released_at'] === 'string' ? j['released_at'] : '',
    commit: typeof j['commit'] === 'string' ? j['commit'].slice(0, 40) : '',
    notes: notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim().slice(0, 200)).slice(0, 10),
    min_os: typeof j['min_os'] === 'string' && /^\d+(\.\d+){0,2}$/.test(j['min_os']) ? j['min_os'] : '',
    files: { zip: file(f['zip'], config, host, 'the update archive'), ...(f['dmg'] ? { dmg: file(f['dmg'], config, host, 'the disk image') } : {}) },
  };
}

export type FeedDecision =
  | { kind: 'update'; feed: Feed }
  | { kind: 'current' }
  /** The feed is OLDER than this build (or blocked after a rollback): never installed. */
  | { kind: 'not-newer'; feed: Feed }
  | { kind: 'blocked'; feed: Feed }
  | { kind: 'other-channel'; feed: Feed }
  | { kind: 'needs-newer-os'; feed: Feed };

export function decide(feed: Feed, current: { version: string; channel: string; osVersion?: string; blocked?: string[] }): FeedDecision {
  const order = compareSemver(feed.version, current.version);
  if (order === 0) return { kind: 'current' };
  if (order < 0) return { kind: 'not-newer', feed };
  if (feed.channel !== current.channel) return { kind: 'other-channel', feed };
  if (current.blocked?.includes(feed.version)) return { kind: 'blocked', feed };
  if (feed.min_os && current.osVersion && compareOsVersion(current.osVersion, feed.min_os) < 0) return { kind: 'needs-newer-os', feed };
  return { kind: 'update', feed };
}

export async function fetchFeed(config: FeedConfig, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Feed> {
  const url = checkUrl(config.url, config, null, 'the update feed');
  const doFetch = opts.fetch ?? fetch;
  let text: string;
  try {
    // redirect:'error' — a redirect would move the request off the pinned host.
    const res = await doFetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? FEED_TIMEOUT_MS), headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if (res.status === 403 || res.status === 404) throw new FeedError('not_published', 'no update has been published yet');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    if (e instanceof FeedError) throw e;
    throw new FeedError('fetch_failed', `could not reach the update server: ${(e as Error).message}`);
  }
  if (text.length > FEED_MAX_BYTES) throw new FeedError('malformed', 'the update feed is too large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new FeedError('malformed', 'the update feed is not JSON');
  }
  return parseFeed(json, config);
}
