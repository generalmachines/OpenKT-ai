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
      if (item.page_id && (sectionsPerPage.get(item.page_id) ?? 0) >= RECALL.maxSectionsPerPage) continue; // (a)
    } else {
      if (cited.has(item.id)) continue; // (c)
      if (item.session_id && (factsPerSession.get(item.session_id) ?? 0) >= RECALL.maxFactsPerSession) continue; // (b)
    }
    // (d) a skipped item never counts toward the caps or the citations —
    // only returned sections and facts are "already kept".
    if (chars + item.text.length > RECALL.charBudget) continue;
    chars += item.text.length;
    kept.push(item);
    if (item.type === "section") {
      if (item.page_id) sectionsPerPage.set(item.page_id, (sectionsPerPage.get(item.page_id) ?? 0) + 1);
      for (const id of item.cites) cited.add(id);
    } else if (item.session_id) {
      factsPerSession.set(item.session_id, (factsPerSession.get(item.session_id) ?? 0) + 1);
    }
  }

  const sections = kept.filter((item) => item.type === "section");
  const facts = kept.filter((item) => item.type === "fact");
  return [...sections, ...facts];
}
