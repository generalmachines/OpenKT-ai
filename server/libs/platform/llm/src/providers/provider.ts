// Provider abstraction for the LLM gateway.
//
// Each provider knows how to talk to one upstream chat-completions API.
// The gateway composes providers into a fallback chain (primary →
// secondary) and wraps every attempt with the circuit breaker + retry
// machinery defined in ../circuit-breaker.ts.
//
// The interface stays deliberately narrow: every provider returns the
// same `ProviderCallResult` shape — text + usage + the upstream HTTP
// status — so the gateway can record the call without caring which
// provider produced it.

export type LlmProviderId = "minimax" | "openai" | "openrouter" | "custom";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderCallRequest {
  messages: LlmMessage[];
  model?: string;
  maxOutputTokens?: number;
  timeoutMs: number; // resolved by the gateway; provider must not default
  // Optional explicit overrides — when set, the provider uses these
  // instead of its env-resolved defaults. Used for per-call config
  // injection (the LlmProviderConfig path).
  baseUrlOverride?: string;
  apiKeyOverride?: string;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ProviderCallResult {
  text: string;
  usage: ProviderUsage;
  model: string;
  // Raw upstream response body — kept around so the gateway can hand
  // it to the recorder when needed, and tests can assert on it.
  raw: unknown;
}

// Errors thrown by providers carry an HTTP-ish status so the breaker
// can classify them. Network/timeout failures use status 0.
export class ProviderError extends Error {
  readonly status: number;
  readonly providerId: LlmProviderId;
  readonly retryable: boolean;
  readonly code: string | null;

  constructor(args: {
    providerId: LlmProviderId;
    message: string;
    status: number;
    retryable: boolean;
    code?: string | null;
  }) {
    super(args.message);
    this.name = "ProviderError";
    this.providerId = args.providerId;
    this.status = args.status;
    this.retryable = args.retryable;
    this.code = args.code ?? null;
  }
}

export interface LlmProvider {
  readonly id: LlmProviderId;

  // Resolves whether this provider has the configuration it needs to
  // run. Used by the gateway to skip providers that are unconfigured
  // (e.g. fallback OPENAI when OPENAI_API_KEY isn't set) instead of
  // exploding at call time.
  isConfigured(): boolean;

  // Runs a single chat-completion call. Implementations MUST honor
  // `request.timeoutMs` and MUST throw `ProviderError` on any failure
  // (HTTP non-2xx, network error, timeout) so the gateway can classify
  // for retry / fallback / circuit-breaker accounting.
  generate(request: ProviderCallRequest): Promise<ProviderCallResult>;
}
