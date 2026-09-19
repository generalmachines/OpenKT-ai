// Pure functions for the "decayed importance now" computation. The
// model is a simple exponential decay against `importance_at`:
//
//   decayed = importance * exp(-decay_lambda * days_elapsed)
//
// `decay_lambda` is a per-row coefficient — small values (~0.01) mean
// roughly 1% loss per day; larger values mean steeper falloff. The API
// surfaces both the raw number and a coarse "state" badge so the UI
// doesn't have to replicate the thresholds.
//
// This file is intentionally pure: no Nest, no DB, no IO. It's
// import-cheap so the recall path and the queries path can both call
// it on hot rows without paying any module-graph cost.

export type DecayState = "fresh" | "warm" | "decaying" | "stale";

export function decayedImportance(
  importance: number,
  decayLambda: number,
  importanceAt: Date,
  now: Date = new Date(),
): number {
  if (!Number.isFinite(importance)) return 0;
  if (!Number.isFinite(decayLambda) || decayLambda <= 0) return clampUnit(importance);
  const elapsedMs = now.getTime() - importanceAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return clampUnit(importance);
  const daysElapsed = elapsedMs / (1000 * 60 * 60 * 24);
  const decayed = importance * Math.exp(-decayLambda * daysElapsed);
  return clampUnit(decayed);
}

export function decayState(decayed: number): DecayState {
  if (!Number.isFinite(decayed)) return "stale";
  if (decayed >= 0.7) return "fresh";
  if (decayed >= 0.4) return "warm";
  if (decayed >= 0.15) return "decaying";
  return "stale";
}

// Helper for the common "I have a raw row, give me both fields"
// pattern. Accepts string ISO dates as well as Date instances because
// the repository's `toRecord` shapes already produce strings; we don't
// want every call site to re-parse.
export function decayFieldsFromRecord(
  importance: number,
  decayLambda: number,
  importanceAt: string | Date,
  now: Date = new Date(),
): { importance_now: number; decay_state: DecayState } {
  const at = importanceAt instanceof Date ? importanceAt : new Date(importanceAt);
  const decayed = decayedImportance(importance, decayLambda, at, now);
  return {
    importance_now: decayed,
    decay_state: decayState(decayed),
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
