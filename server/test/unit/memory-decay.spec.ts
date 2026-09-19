// Unit tests for the pure decay functions. No Nest, no DB — these
// functions are import-cheap so every memory-record shaping call can
// invoke them on hot rows.

import {
  decayFieldsFromRecord,
  decayState,
  decayedImportance,
} from "../../apps/server/src/modules/memory/services/memory-decay";

describe("decayedImportance", () => {
  const importanceAt = new Date("2026-01-01T00:00:00.000Z");

  it("returns ~0.37 for importance=1, lambda=0.01, 100 days elapsed", () => {
    const now = new Date(importanceAt.getTime() + 100 * 24 * 60 * 60 * 1000);
    const value = decayedImportance(1, 0.01, importanceAt, now);
    // exp(-1) ≈ 0.367879
    expect(value).toBeGreaterThan(0.36);
    expect(value).toBeLessThan(0.38);
  });

  it("returns the raw importance when zero days elapsed", () => {
    expect(decayedImportance(0.8, 0.01, importanceAt, importanceAt)).toBeCloseTo(0.8, 5);
  });

  it("clamps to [0,1]", () => {
    // Negative importance should clamp to 0; passing > 1 stays in unit
    // range after the function returns.
    expect(decayedImportance(-0.5, 0.01, importanceAt)).toBe(0);
    expect(decayedImportance(2, 0, importanceAt)).toBeLessThanOrEqual(1);
  });

  it("returns importance unchanged when lambda is 0 (no decay)", () => {
    const now = new Date(importanceAt.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(decayedImportance(0.5, 0, importanceAt, now)).toBe(0.5);
  });

  it("handles future importance_at by returning the raw importance", () => {
    // If the row's importance_at is in the future, days elapsed is
    // negative — we clamp to "no decay yet".
    const past = new Date("2026-01-01T00:00:00.000Z");
    const future = new Date("2026-06-01T00:00:00.000Z");
    expect(decayedImportance(0.5, 0.01, future, past)).toBeCloseTo(0.5, 5);
  });
});

describe("decayState", () => {
  it("returns the correct band for each threshold", () => {
    expect(decayState(0.9)).toBe("fresh");
    expect(decayState(0.7)).toBe("fresh");
    expect(decayState(0.55)).toBe("warm");
    expect(decayState(0.4)).toBe("warm");
    expect(decayState(0.25)).toBe("decaying");
    expect(decayState(0.15)).toBe("decaying");
    expect(decayState(0.1)).toBe("stale");
    expect(decayState(0)).toBe("stale");
  });

  it("treats NaN as stale", () => {
    expect(decayState(Number.NaN)).toBe("stale");
  });
});

describe("decayFieldsFromRecord", () => {
  it("returns both fields from a Date importanceAt", () => {
    const importanceAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(importanceAt.getTime() + 100 * 24 * 60 * 60 * 1000);
    const out = decayFieldsFromRecord(1, 0.01, importanceAt, now);
    expect(out.importance_now).toBeGreaterThan(0.36);
    expect(out.importance_now).toBeLessThan(0.38);
    expect(out.decay_state).toBe("decaying");
  });

  it("accepts an ISO string for importance_at", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-01-01T00:00:00.000Z");
    const out = decayFieldsFromRecord(0.9, 0.01, at, now);
    expect(out.importance_now).toBeCloseTo(0.9, 5);
    expect(out.decay_state).toBe("fresh");
  });
});
