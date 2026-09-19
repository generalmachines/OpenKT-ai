// All recall tuning numbers in one place (Spec 01 §4). Frozen: tuning happens
// in a commit, never at runtime.

export const RECALL = Object.freeze({
  scope: Object.freeze({ S0: 1.3, S1: 1.1, S2: 1.2, S3: 1.0, S4: 1.0 }),
  sectionBoost: 1.15,
  pinnedBoost: 1.25,
  lockedBoost: 1.1,
  recencyFloor: 0.85,
  recencySpan: 0.15,
  recencyHalfLifeDays: 90,
  hubPenalty: 0.15,
  rrfK: 60,
  rerankBlend: 0.6,
  abstainRerank: 0.2,
  abstainCosine: 0.3,
  maxSectionsPerPage: 2,
  maxFactsPerSession: 3,
  charBudget: 6000,
  candidateLimit: 40,
  rerankTop: 50,
});
