// Static price table for LLM observability cost rollups.
//
// Prices are USD per token (NOT per 1M tokens) so the arithmetic stays
// simple inside the recording middleware. Keys are lowercase
// `provider:model` so lookups survive case-drift between dashboards
// and runtime configuration.
//
// TODO(observability): wire this to the LLM provider config table so
// teams running custom providers can override pricing without a deploy.

export interface ModelPricing {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
}

// Helper: convert dollars-per-million-tokens to dollars-per-token.
function perMillion(value: number): number {
  return value / 1_000_000;
}

// MiniMax M2.5: $0.30 / $1.20 per 1M tokens (input / output).
// MiniMax M2.7 we model identically until we have a published price.
// OpenAI text-embedding-3-small: $0.02 per 1M tokens, output not used.
//
// Unknown (provider, model) pairs fall through to ZERO_PRICING so the
// llm_calls row still records token counts and we don't double-count
// dollars against a guess.
const KNOWN_PRICES: Record<string, ModelPricing> = {
  "minimax:minimax-m2.5": {
    inputUsdPerToken: perMillion(0.3),
    outputUsdPerToken: perMillion(1.2),
  },
  "minimax:minimax-m2.7": {
    inputUsdPerToken: perMillion(0.3),
    outputUsdPerToken: perMillion(1.2),
  },
  "openai:text-embedding-3-small": {
    inputUsdPerToken: perMillion(0.02),
    outputUsdPerToken: 0,
  },
};

export const ZERO_PRICING: ModelPricing = {
  inputUsdPerToken: 0,
  outputUsdPerToken: 0,
};

export function lookupPricing(provider: string, model: string): ModelPricing {
  const key = `${provider.toLowerCase()}:${model.toLowerCase()}`;
  return KNOWN_PRICES[key] ?? ZERO_PRICING;
}

export function computeCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = lookupPricing(provider, model);
  // Clamp inputs to non-negative finite numbers. Providers occasionally
  // emit NaN / negative / Infinity token counts when usage metadata
  // arrives mid-stream; multiplying those through would surface a
  // negative or non-numeric cost that fails the `numeric(10,6)` column
  // downstream.
  const inputCost = clampTokens(promptTokens) * pricing.inputUsdPerToken;
  const outputCost = clampTokens(completionTokens) * pricing.outputUsdPerToken;
  // Round to 6 decimal places so the numeric(10,6) column never trips
  // on precision drift between JS floats and Postgres.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

function clampTokens(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}
