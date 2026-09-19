// Finalize (Spec 01 §4 steps 7–8): a ranked list becomes the returned page —
// diversity caps, citation de-duplication, character budget.

import { RECALL } from "./constants.js";
import type { Scored } from "./types.js";

const MAX_K = 20;

export function finalize(ranked: Scored[], k: number): Scored[] {
  const limit = Math.max(1, Math.min(k, MAX_K));

  const kept: Scored[] = [];
  const sectionsPerPage = new Map<string, number>();
  const factsPerSession = new Map<string, number>();
  const cited = new Set<string>();
  let chars = 0;

  for (const item of ranked) {
    if (kept.length >= limit) break;

    if (item.type === "section") {
      const perPage = item.page_id ? (sectionsPerPage.get(item.page_id) ?? 0) : 0;
      // (a) at most 2 sections of the same page
      if (item.page_id && perPage >= RECALL.maxSectionsPerPage) continue;
      // (c) a fact a kept section already cites is redundant.
      for (const id of item.cites) cited.add(id);
      sectionsPerPage.set(item.page_id as string, perPage + 1);
    } else {
      // (c) the section carries this fact's content already.
      if (cited.has(item.id)) continue;
      const perSession = item.session_id ? (factsPerSession.get(item.session_id) ?? 0) : 0;
      // (b) at most 3 facts per session; facts without a session are unlimited.
      if (item.session_id && perSession >= RECALL.maxFactsPerSession) continue;
      if (item.session_id) factsPerSession.set(item.session_id, perSession + 1);
    }

    // (d) the budget never blocks a shorter later item.
    if (chars + item.text.length > RECALL.charBudget) continue;

    chars += item.text.length;
    kept.push(item);
  }

  const sections = kept.filter((item) => item.type === "section");
  const facts = kept.filter((item) => item.type === "fact");
  return [...sections, ...facts];
}
