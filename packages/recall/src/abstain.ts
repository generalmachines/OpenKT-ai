// Abstention (Spec 01 §4 step 6): say "nothing relevant" instead of
// returning weak matches.

import { RECALL } from "./constants.js";

export function shouldAbstain(items: { rerank?: number; similarity?: number }[]): boolean {
  if (items.length === 0) return true;

  // When reranking ran at all, its rule wins — even if only one item carries
  // a rerank score.
  const reranked = items.filter((item) => item.rerank !== undefined);
  if (reranked.length > 0) {
    return Math.max(...reranked.map((item) => item.rerank as number)) < RECALL.abstainRerank;
  }

  return Math.max(...items.map((item) => item.similarity ?? 0)) < RECALL.abstainCosine;
}
