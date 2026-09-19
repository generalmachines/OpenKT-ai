// Reciprocal rank fusion (Spec 01 §4 step 3): fused = Σ 1 / (k + rank) over
// the candidate lists an item appeared in. A missing rank contributes 0.

import { InvalidInputError } from "./errors.js";
import type { Candidate } from "./types.js";

const VALID_RANK_KEYS = ["vector", "keyword"] as const;
type RankKey = (typeof VALID_RANK_KEYS)[number];

export function fuse(
  candidates: Candidate[],
  k = 60,
): (Candidate & { fused: number })[] {
  const out = candidates.map((c) => {
    let fused = 0;
    let hasRank = false;
    for (const key of VALID_RANK_KEYS) {
      const rank = (c.ranks as Record<RankKey, number | undefined>)[key];
      if (rank === undefined) continue;
      hasRank = true;
      if (!Number.isInteger(rank) || rank < 1) {
        throw new InvalidInputError(`invalid ${key} rank ${rank} for candidate ${c.id}`);
      }
      fused += 1 / (k + rank);
    }
    if (!hasRank) {
      throw new InvalidInputError(`candidate ${c.id} has no rank in any list`);
    }
    return { ...c, fused };
  });
  return out.sort((a, b) => b.fused - a.fused || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
