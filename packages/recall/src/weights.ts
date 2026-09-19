// Post-fusion weighting (Spec 01 §4 step 4): fused score × scope × type ×
// recency × pinned × locked × hub, then sorted by the weighted score.

import { RECALL } from "./constants.js";
import type { Candidate } from "./types.js";

const MS_PER_DAY = 86_400_000;

export function applyWeights(
  items: (Candidate & { fused: number })[],
  now: Date,
): (Candidate & { fused: number; weighted: number })[] {
  return items
    .map((item) => {
      const scope = RECALL.scope[item.scope];
      const typeBoost = item.type === "section" ? RECALL.sectionBoost : 1;
      const ageDays = Math.max(0, (now.getTime() - Date.parse(item.created_at)) / MS_PER_DAY);
      const recency =
        RECALL.recencyFloor + RECALL.recencySpan * Math.exp(-ageDays / RECALL.recencyHalfLifeDays);
      const hub = 1 / (1 + RECALL.hubPenalty * Math.log(1 + item.recalls_30d_unused));
      const weighted =
        item.fused *
        scope *
        typeBoost *
        recency *
        (item.is_pinned ? RECALL.pinnedBoost : 1) *
        (item.locked ? RECALL.lockedBoost : 1) *
        hub;
      return { ...item, weighted };
    })
    .sort((a, b) => b.weighted - a.weighted || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
