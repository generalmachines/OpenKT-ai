// Per-chunk and per-session fact caps (Spec 02 §2): when over the cap, keep
// the highest-priority kinds first, original order within a kind.

import { KIND_PRIORITY, type Kind } from "./types.js";

export const MAX_FACTS_PER_CHUNK = 12;
export const MAX_FACTS_PER_SESSION = 60;

function priorityIndex(kind: Kind): number {
  const i = KIND_PRIORITY.indexOf(kind);
  return i === -1 ? KIND_PRIORITY.length : i;
}

export function capFacts<T extends { kind: Kind }>(facts: T[], max: number): T[] {
  if (facts.length <= max) return facts;
  const byKind = new Map<Kind, T[]>();
  for (const f of facts) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }
  const kept: { item: T; at: number }[] = [];
  outer: for (const kind of KIND_PRIORITY) {
    for (const item of byKind.get(kind) ?? []) {
      if (kept.length >= max) break outer;
      kept.push({ item, at: facts.indexOf(item) });
    }
  }
  return kept
    .sort((a, b) => a.at - b.at)
    .map((k) => k.item);
}
