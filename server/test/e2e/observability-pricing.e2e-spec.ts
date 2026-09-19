import {
  computeCostUsd,
  lookupPricing,
  ZERO_PRICING,
} from "../../libs/platform/llm/src/pricing";

// Unit-ish tests for the static cost calculator. Lives under
// test/e2e/ because that's the only jest config the repo ships; the
// `.e2e-spec.ts` suffix is just the file naming convention here.

describe("pricing.ts", () => {
  it("returns zero pricing for unknown (provider, model) pairs", () => {
    expect(lookupPricing("anthropic", "claude-future-7")).toBe(ZERO_PRICING);
    expect(computeCostUsd("anthropic", "claude-future-7", 1_000, 2_000)).toBe(0);
  });

  it("prices MiniMax M2.5 at $0.30 / $1.20 per 1M tokens", () => {
    // 1M input + 1M output should cost $0.30 + $1.20 = $1.50.
    const cost = computeCostUsd("minimax", "MiniMax-M2.5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.5, 4);
  });

  it("prices MiniMax M2.7 identically to M2.5 (interim)", () => {
    const m25 = computeCostUsd("minimax", "MiniMax-M2.5", 5000, 5000);
    const m27 = computeCostUsd("minimax", "MiniMax-M2.7", 5000, 5000);
    expect(m27).toBe(m25);
  });

  it("prices OpenAI embedding-3-small at $0.02 per 1M input tokens with no output cost", () => {
    const cost = computeCostUsd("openai", "text-embedding-3-small", 1_000_000, 999_999);
    expect(cost).toBeCloseTo(0.02, 6);
  });

  it("is case-insensitive on provider and model", () => {
    const lower = computeCostUsd("minimax", "minimax-m2.5", 100, 200);
    const mixed = computeCostUsd("MiniMax", "MiniMax-M2.5", 100, 200);
    expect(mixed).toBe(lower);
    expect(lower).toBeGreaterThan(0);
  });

  it("rounds to 6 decimal places so numeric(10,6) never overflows precision", () => {
    const cost = computeCostUsd("minimax", "MiniMax-M2.5", 1, 1);
    // $0.30/1M + $1.20/1M = $1.5e-6 exactly; allow slop for floating math.
    expect(cost).toBe(Math.round(cost * 1_000_000) / 1_000_000);
  });

  it("treats negative or non-finite token counts as zero", () => {
    expect(computeCostUsd("minimax", "MiniMax-M2.5", -5, Number.NaN)).toBe(0);
    expect(computeCostUsd("minimax", "MiniMax-M2.5", Number.POSITIVE_INFINITY, 0)).toBe(0);
    expect(computeCostUsd("minimax", "MiniMax-M2.5", 1000, -1)).toBeGreaterThan(0);
  });
});
