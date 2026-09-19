// OpenAI provider — Chat Completions at `api.openai.com/v1`.
//
// Used as the fallback when the primary (MiniMax) circuit is open or
// has exhausted its retries. Reads the key from `OPENKT_OPENAI_API_KEY`
// first, then falls back to the embedding-side `OPENAI_API_KEY` so
// deployments that already have OpenAI configured for embeddings get
// LLM fallback "for free".

import type { ConfigService } from "@nestjs/config";

import { callOpenAiCompat } from "./openai-compat-client";
import {
  LlmProvider,
  ProviderCallRequest,
  ProviderCallResult,
} from "./provider";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;

export interface OpenAiProviderOptions {
  baseUrlOverride?: string;
  apiKeyOverride?: string;
  modelOverride?: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly id = "openai" as const;

  constructor(
    private readonly configService: ConfigService,
    private readonly options: OpenAiProviderOptions = {},
  ) {}

  isConfigured(): boolean {
    return Boolean(this.resolveApiKey());
  }

  async generate(request: ProviderCallRequest): Promise<ProviderCallResult> {
    const apiKey = request.apiKeyOverride ?? this.resolveApiKey();
    if (!apiKey) {
      throw new Error("OpenAiProvider: missing api key");
    }
    const baseUrl =
      request.baseUrlOverride ??
      this.options.baseUrlOverride ??
      DEFAULT_BASE_URL;
    const model =
      request.model ?? this.options.modelOverride ?? DEFAULT_MODEL;

    return callOpenAiCompat({
      providerId: "openai",
      baseUrl,
      apiKey,
      model,
      request,
      defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
  }

  private resolveApiKey(): string | undefined {
    if (this.options.apiKeyOverride) return this.options.apiKeyOverride;
    // Three fallbacks:
    //   1. OPENKT_OPENAI_API_KEY — preferred (added by this hardening).
    //   2. OPENAI_API_KEY — the embedding-side key; reused so single-key
    //      deployments work out of the box.
    //   3. OPENKT_DEFAULT_LLM_KEY — only when this provider IS the
    //      configured primary (OPENKT_DEFAULT_LLM_PROVIDER=openai).
    //      Preserves the pre-fallback behavior where one default key
    //      drove whichever provider the deployment selected.
    const explicit =
      this.configService.get<string>("OPENKT_OPENAI_API_KEY")?.trim() ||
      this.configService.get<string>("OPENAI_API_KEY")?.trim();
    if (explicit) return explicit;
    const defaultProvider = this.configService
      .get<string>("OPENKT_DEFAULT_LLM_PROVIDER")
      ?.trim();
    if (defaultProvider === "openai") {
      return (
        this.configService.get<string>("OPENKT_DEFAULT_LLM_KEY")?.trim() ||
        undefined
      );
    }
    return undefined;
  }
}
