import { createPublicKey } from "node:crypto";

import { Logger } from "@nestjs/common";

// A JWKS endpoint's public keys, cached by `kid` as PEM strings.
//
// Shared by every verifier that checks tokens signed by someone else
// (Supabase access tokens, Google ID tokens). After warm-up, verification is
// pure crypto with no network: keys are refetched only when the cache goes
// stale or an unknown `kid` shows up (a signing-key rotation).

export interface Jwk {
  kid?: string;
  kty?: string;
  [key: string]: unknown;
}

export interface JwksResponse {
  keys: Jwk[];
  // How long the issuer says the document may be cached (from
  // `cache-control: max-age`). Null → use the cache's default TTL.
  maxAgeMs: number | null;
}

// Injectable so tests sign tokens with a local key and never touch the network.
export type JwksFetcher = (url: string) => Promise<JwksResponse>;

// A stale cache or an unknown `kid` forces a refetch — but at most this often,
// so a stream of junk tokens (or an unreachable issuer) cannot turn every
// request into a JWKS fetch.
const MIN_REFETCH_INTERVAL_MS = 30_000;

export const fetchJwksOverHttp: JwksFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!body.keys || !Array.isArray(body.keys)) throw new Error("response missing keys[]");
  const maxAge = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
  return { keys: body.keys, maxAgeMs: maxAge ? Number(maxAge[1]) * 1000 : null };
};

export class JwksKeyCache {
  private readonly logger = new Logger(JwksKeyCache.name);
  private keys = new Map<string, string>();
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private ttlMs: number;
  // Coalesce concurrent fetches so a cold-cache burst produces one GET, not N.
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly defaultTtlMs: number,
    private readonly fetcher: JwksFetcher = fetchJwksOverHttp,
  ) {
    this.ttlMs = defaultTtlMs;
  }

  // The PEM for `kid`, or null when the issuer does not publish such a key.
  async getKey(kid: string): Promise<string | null> {
    const fresh = Date.now() - this.fetchedAt < this.ttlMs;
    const cached = this.keys.get(kid);
    if (cached && fresh) return cached;
    if (Date.now() - this.lastAttemptAt >= MIN_REFETCH_INTERVAL_MS) await this.refresh();
    return this.keys.get(kid) ?? null;
  }

  private async refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.doFetch().finally(() => {
        this.inflight = null;
      });
    }
    await this.inflight;
  }

  private async doFetch(): Promise<void> {
    this.lastAttemptAt = Date.now();
    let response: JwksResponse;
    try {
      response = await this.fetcher(this.url);
    } catch (err) {
      // Keep stale keys rather than failing closed — losing the JWKS endpoint
      // for a moment should not reject every token signed by a known key.
      this.logger.warn(`[jwks-fetch] ${this.url}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const next = new Map<string, string>();
    for (const jwk of response.keys) {
      if (!jwk.kid) continue;
      try {
        const pem = createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" }) as string;
        next.set(jwk.kid, pem);
      } catch (err) {
        this.logger.warn(`[jwks-fetch] failed to import kid=${jwk.kid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.keys = next;
    this.fetchedAt = Date.now();
    this.ttlMs = response.maxAgeMs && response.maxAgeMs > 0 ? response.maxAgeMs : this.defaultTtlMs;
  }
}

// The `kid` from a JWT header, without verifying anything.
export function peekKid(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8")) as { kid?: unknown };
    return typeof parsed.kid === "string" ? parsed.kid : null;
  } catch {
    return null;
  }
}
