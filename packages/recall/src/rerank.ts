// Rerank client (Spec 01 §4 step 5): the top 50 candidates go through a
// cross-encoder over HTTP; the blended score is returned. Never throws — a
// bad endpoint silently degrades to the no-rerank result.

import { RECALL } from "./constants.js";
import type { Scored } from "./types.js";

const DEFAULT_TIMEOUT_MS = 3000;

export interface RerankerOptions {
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (e: unknown) => void;
}

interface RerankEntry {
  index: number;
  score: number;
}

function isUsableScore(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function createReranker(opts: RerankerOptions = {}): {
  rerank: (query: string, items: Scored[]) => Promise<Scored[]>;
} {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // No-rerank result (spec step 2): the input unchanged, score = weighted.
  const withoutRerank = (items: Scored[]): Scored[] =>
    items.map((item) => ({ ...item, score: item.weighted }));

  async function rerank(query: string, items: Scored[]): Promise<Scored[]> {
    if (items.length === 0) return [];
    if (!opts.url) return withoutRerank(items);

    const max = Math.max(...items.map((i) => i.weighted), 0);
    const normalised = items.map((i) => (max > 0 ? i.weighted / max : 0));

    const top = items.slice(0, RECALL.rerankTop);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // The timeout must cover the body read too — a server that sends
      // headers and then stalls would otherwise hang recall.
      let body: unknown;
      try {
        const response = await fetchImpl(`${opts.url}/rerank`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({ query, texts: top.map((i) => i.text), raw_scores: false }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`rerank endpoint returned ${response.status}`);
        body = await response.json();
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(body) || body.length !== top.length) {
        throw new Error("malformed rerank response body");
      }
      // TEI returns results sorted by score, so match by the `index` field —
      // not by position. Length + range + no duplicates ⇒ every index present.
      const byIndex = new Map<number, number>();
      for (const entry of body as RerankEntry[]) {
        const s = (entry as { score?: unknown }).score;
        const idx = (entry as { index?: unknown }).index;
        if (
          !isUsableScore(s) ||
          typeof idx !== "number" ||
          !Number.isInteger(idx) ||
          idx < 0 ||
          idx >= top.length
        ) {
          throw new Error("malformed rerank response entry");
        }
        if (byIndex.has(idx)) throw new Error("duplicate index in rerank response");
        byIndex.set(idx, s);
      }

      return items
        .map((item, i) => {
          const normalisedItem = normalised[i]!;
          if (i < RECALL.rerankTop) {
            const rerankScore = byIndex.get(i)!;
            return {
              ...item,
              rerank: rerankScore,
              score: (1 - RECALL.rerankBlend) * normalisedItem + RECALL.rerankBlend * rerankScore,
            };
          }
          return { ...item, score: 0.4 * normalisedItem };
        })
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch (err) {
      opts.onError?.(err);
      return withoutRerank(items);
    }
  }

  return { rerank };
}
