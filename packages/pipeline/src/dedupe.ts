// Duplicate and supersede (Spec 02 §3): the arithmetic decisions are made in
// code; only the grey zone (0.82 ≤ s < 0.97) goes to the dedupe agent.

import type { Kind, Neighbour } from "./types.js";

export const DUP_AUTO = 0.97;
export const DUP_ASK = 0.82;
export const MAX_SUPERSEDES = 3;
export const MAX_ASK_CANDIDATES = 10;

export type DuplicateDecision =
  | { action: "duplicate"; of: string }
  | { action: "ask_agent"; candidates: Neighbour[] }
  | { action: "new" };

export function decideDuplicate(neighbours: Neighbour[]): DuplicateDecision {
  if (neighbours.length === 0) return { action: "new" };

  const firstProject = neighbours[0]!.project_id;
  const pool = neighbours.filter(
    (n) =>
      n.project_id === firstProject &&
      typeof n.similarity === "number" &&
      Number.isFinite(n.similarity),
  );
  if (pool.length === 0) return { action: "new" };

  const best = pool.reduce((a, b) => (b.similarity > a.similarity ? b : a));
  if (best.similarity >= DUP_AUTO) return { action: "duplicate", of: best.id };
  if (best.similarity >= DUP_ASK) {
    const candidates = pool
      .filter((n) => n.similarity >= DUP_ASK)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, MAX_ASK_CANDIDATES);
    return { action: "ask_agent", candidates };
  }
  return { action: "new" };
}

export interface SupersedeInput {
  kind: Kind;
  created_at: string;
  project_id: string;
  owner_user_id: string;
}

export interface SupersedeAnswer {
  duplicate_of: string | null;
  supersedes: string[];
}

const SUPERSEDE_OK_KINDS: readonly Kind[] = ["decision", "fact", "how-to"];

export function guardSupersede(
  newFact: SupersedeInput,
  agentAnswer: { duplicate_of: string | null; supersedes: string[] },
  candidates: Neighbour[],
): {
  duplicate_of: string | null;
  supersedes: string[];
  rejected: { id: string; reason: string }[];
} {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rejected: { id: string; reason: string }[] = [];

  // An id not in the input list is ignored (Spec 02 §3).
  const duplicateOf =
    agentAnswer.duplicate_of !== null && byId.has(agentAnswer.duplicate_of)
      ? agentAnswer.duplicate_of
      : null;

  // A duplicate answer wins; supersedes is forced empty.
  if (duplicateOf !== null) {
    return { duplicate_of: duplicateOf, supersedes: [], rejected };
  }

  const newTime = Date.parse(newFact.created_at);

  // Pass 1: the guards, with repeated ids de-duplicated.
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const id of agentAnswer.supersedes) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = byId.get(id);
    if (!target) {
      rejected.push({ id, reason: "unknown_id" });
      continue;
    }
    const targetTime = Date.parse(target.created_at);
    // "Older" compares created_at as instants, never as text (Spec 02 §3).
    if (Number.isNaN(targetTime) || Number.isNaN(newTime)) {
      rejected.push({ id, reason: "bad_date" });
      continue;
    }
    if (targetTime >= newTime) {
      rejected.push({ id, reason: "not_older" });
      continue;
    }
    if (target.project_id !== newFact.project_id) {
      rejected.push({ id, reason: "other_project" });
      continue;
    }
    const needsPrivilege = target.is_pinned || target.owner_user_id !== newFact.owner_user_id;
    if (needsPrivilege && !SUPERSEDE_OK_KINDS.includes(newFact.kind)) {
      rejected.push({ id, reason: "protected_target" });
      continue;
    }
    valid.push(id);
  }

  // Pass 2: the cap counts only ids that survived the guards.
  if (valid.length > MAX_SUPERSEDES) {
    return {
      duplicate_of: null,
      supersedes: [],
      rejected: [
        ...rejected,
        ...valid.map((id) => ({ id, reason: "suspicious_supersede" })),
      ],
    };
  }

  return { duplicate_of: null, supersedes: valid, rejected };
}
