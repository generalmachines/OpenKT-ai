// MiniMax provider — talks to the user-controlled proxy at
// `api.minimax.villamarket.ai/v1`. Speaks OpenAI Chat Completions wire
// format so it shares the openai-compat client.
//
// Configuration is read from env. The two relevant knobs are
// `OPENKT_DEFAULT_LLM_KEY` (or the legacy `OPENKT_MINIMAX_API_KEY`)
// and `OPENKT_DEFAULT_LLM_BASE_URL` / model override. The provider
// remains "unconfigured" when no key is present; the gateway then
// skips it in the chain.

import type { ConfigService } from "@nestjs/config";

import { callOpenAiCompat } from "./openai-compat-client";
import {
  LlmProvider,
  ProviderCallRequest,
  ProviderCallResult,
} from "./provider";

const DEFAULT_BASE_URL = "https://api.minimax.villamarket.ai/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;

export interface MinimaxProviderOptions {
  // Optional explicit defaults — used by the gateway when wiring a
  // per-call `LlmProviderConfig`. When unset, the provider falls back
  // to env.
  baseUrlOverride?: string;
  apiKeyOverride?: string;
  modelOverride?: string;
}

export class MinimaxProvider implements LlmProvider {
  readonly id = "minimax" as const;

  constructor(
    private readonly configService: ConfigService,
    private readonly options: MinimaxProviderOptions = {},
  ) {}

  isConfigured(): boolean {
    return Boolean(this.resolveApiKey());
  }

  async generate(request: ProviderCallRequest): Promise<ProviderCallResult> {
    const apiKey = request.apiKeyOverride ?? this.resolveApiKey();
    if (!apiKey) {
      throw new Error("MinimaxProvider: missing api key");
    }
    const baseUrl =
      request.baseUrlOverride ??
      this.options.baseUrlOverride ??
      this.configService.get<string>("OPENKT_DEFAULT_LLM_BASE_URL")?.trim() ??
      DEFAULT_BASE_URL;

    const envModel = this.configService
      .get<string>("OPENKT_DEFAULT_LLM_MODEL")
      ?.trim();
    const model =
      request.model ??
      this.options.modelOverride ??
      (envModel && envModel.length > 0 ? envModel : DEFAULT_MODEL);

    return callOpenAiCompat({
      providerId: "minimax",
      baseUrl,
      apiKey,
      model,
      request,
      defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
  }

  private resolveApiKey(): string | undefined {
    if (this.options.apiKeyOverride) return this.options.apiKeyOverride;
    // OPENKT_DEFAULT_LLM_KEY is the canonical key today (the gateway
    // historically routed everything through it). Both name variants
    // exist in deployment configs.
    return (
      this.configService.get<string>("OPENKT_DEFAULT_LLM_KEY")?.trim() ||
      this.configService.get<string>("OPENKT_MINIMAX_API_KEY")?.trim() ||
      undefined
    );
  }
}
