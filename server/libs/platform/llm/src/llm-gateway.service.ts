import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ZodType } from "zod";

import { CircuitBreaker } from "./circuit-breaker";
import { LlmProvidersExhaustedError, LlmQuotaExceededError } from "./errors";
import type { ProviderAttemptSummary } from "./errors";
import { getLlmCallContext } from "./llm-call-context";
import { computeCostUsd } from "./pricing";
import { MinimaxProvider, OpenAiProvider } from "./providers";
import type {
  LlmProvider as LlmProviderInterface,
  LlmProviderId,
  ProviderCallRequest,
  ProviderError,
} from "./providers";

// `LlmProvider` historically was the union of provider identifiers.
// Keep that public shape so existing call sites (controllers, worker)
// don't need to change while we also introduce the new interface
// (re-exported below for new consumers).
export type DefaultLlmProvider = "minimax" | "openai" | "openrouter";
export type LlmProvider = DefaultLlmProvider | "custom";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallInput {
  messages: LlmMessage[];
  model?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  providerConfig?: LlmProviderConfig | null;
}

export interface CallMeta {
  // True when the primary provider failed and the call succeeded via a
  // fallback. Callers can surface this in their own observability.
  fallbackUsed: boolean;
  // The ordered list of providers that were attempted, primary-first.
  providerChain: LlmProviderId[];
}

export interface ObjectResult<T> {
  object: T;
  provider: LlmProvider;
  model: string;
  meta: CallMeta;
}

export interface TextResult {
  text: string;
  provider: LlmProvider;
  model: string;
  meta: CallMeta;
}

export interface LlmProviderConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
}

// Recording sink — supplied by the server app's observability module.
// The LLM gateway lib is shared by server + worker and must not
// reach into a NestJS module graph that only the server owns. The
// optional injection point keeps the worker functioning even when no
// recorder is registered.
export const LLM_CALL_RECORDER = Symbol("LLM_CALL_RECORDER");

export interface LlmCallRecordInput {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status:
    | "success"
    | "error"
    | "timeout"
    | "rate_limited"
    | "quota_exceeded"
    | "fallback_used";
  errorReason?: string | null;
  costUsd: number;
  // ── Full I/O capture (migration 0025) ─────────────────────────────
  // The gateway passes the prompt that was actually sent + the raw
  // response text + the provider's response metadata (usage,
  // finish_reason, model, id) so the trace endpoint can show
  // "this triage decision was based on prompt X and got back Y".
  // Each prompt message's `content` is truncated to 8KB by the
  // recorder before insert; `truncated` flips true on any truncation.
  // All three fields are optional so recorders that pre-date this
  // capability (or have OPENKT_LLM_IO_CAPTURE=false) simply skip them.
  promptMessages?: LlmMessage[];
  responseText?: string | null;
  responseMetadata?: Record<string, unknown> | null;
}

export interface LlmCallRecorder {
  record(input: LlmCallRecordInput): Promise<void> | void;
}

// Per-user quota gate — also supplied by the host app. Same rationale
// as LLM_CALL_RECORDER: the gateway must work standalone for tests and
// for boot-time tooling, so the binding is optional. When unbound the
// gateway behaves exactly as before (no quota enforcement).
//
// Enforcement semantics:
//   1. `checkAndReserve` runs BEFORE every provider attempt. If it
//      returns `allowed: false`, the gateway throws
//      `LlmQuotaExceededError` synchronously — no upstream call is
//      made and no fallback is attempted (quota is per-user, not
//      per-provider).
//   2. `commitUsage` runs AFTER a successful provider attempt, with
//      the actual token counts from the provider's response. Best
//      effort — failures are swallowed.
//   3. Both methods may throw on infrastructure errors (DB blip etc.)
//      The gateway intentionally FAILS OPEN — a quota DB outage must
//      not block the entire LLM surface; we'd rather over-serve a few
//      calls than 5xx every memory the pipeline tries to process.
export const LLM_QUOTA_CHECK = Symbol("LLM_QUOTA_CHECK");

export interface LlmQuotaCheckResult {
  allowed: boolean;
  tokensRemaining?: number | null;
  tokensLimit?: number | null;
  resetAt?: Date | null;
  reason?: string | null;
}

export interface LlmQuotaChecker {
  checkAndReserve(input: {
    userId: string;
    provider: string;
    estimatedTokens: number;
  }): Promise<LlmQuotaCheckResult>;
  commitUsage(input: {
    userId: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  }): Promise<void>;
}

const DEFAULTS: Record<DefaultLlmProvider, { model: string; baseUrl: string }> = {
  minimax: {
    model: "MiniMax-M2.7",
    baseUrl: "https://api.minimax.villamarket.ai/v1",
  },
  openai: {
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  openrouter: {
    model: "anthropic/claude-haiku-4.5",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;
const JSON_ONLY_NUDGE =
  "\n\nIMPORTANT OUTPUT FORMAT: Respond with ONLY a single valid JSON object. " +
  "No prose, no markdown fences, no headings, no explanations. " +
  "The response body must start with `{` and end with `}`.";

@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);
  // Per-instance breaker — restart resets state. That's intentional
  // (see circuit-breaker.ts).
  private readonly breaker: CircuitBreaker;
  // Lazily-built provider instances. Keyed by id so we don't construct
  // an OpenAI provider when the deployment hasn't even given us a key.
  private readonly providerCache: Map<LlmProviderId, LlmProviderInterface> =
    new Map();

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(LLM_CALL_RECORDER) private readonly recorder?: LlmCallRecorder,
    @Optional() @Inject(LLM_QUOTA_CHECK) private readonly quotaChecker?: LlmQuotaChecker,
  ) {
    this.breaker = new CircuitBreaker(this.resolveBreakerOptions());
  }

  // Pull breaker / retry knobs from env. Used at construction; the
  // gateway intentionally doesn't re-read these per-call so we have a
  // single, stable policy per process. The hidden test-friendly knobs
  // (`OPENKT_LLM_RETRY_DELAYS_MS`, `OPENKT_LLM_DISABLE_RETRY_SLEEP`)
  // let suites pin retries to zero without monkey-patching setTimeout.
  private resolveBreakerOptions() {
    const opts: Partial<import("./circuit-breaker").CircuitBreakerOptions> = {};
    const delaysCsv = this.configService.get<string>(
      "OPENKT_LLM_RETRY_DELAYS_MS",
    );
    if (typeof delaysCsv === "string" && delaysCsv.length > 0) {
      const parsed = delaysCsv
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (parsed.length > 0) opts.retryDelaysMs = parsed;
    }
    const disableSleep =
      this.configService.get<string | boolean>("OPENKT_LLM_DISABLE_RETRY_SLEEP");
    const nodeEnv = this.configService.get<string>("NODE_ENV") ?? process.env.NODE_ENV;
    if (disableSleep === true || disableSleep === "true" || nodeEnv === "test") {
      // In jest, real backoff (1s + 4s + 12s) blows the 15s default
      // test timeout. Default to instant retries under NODE_ENV=test.
      opts.sleep = () => Promise.resolve();
    }
    return opts;
  }

  // Public for tests + observability. Returns the breaker so callers
  // can introspect provider state (e.g. an /internal/health endpoint).
  getCircuitBreaker(): CircuitBreaker {
    return this.breaker;
  }

  async tryGenerateText(input: CallInput): Promise<TextResult | null> {
    const result = await this.runChain(input);
    if (!result) return null;
    return {
      text: result.text,
      provider: result.providerId as LlmProvider,
      model: result.model,
      meta: result.meta,
    };
  }

  async tryGenerateObject<T>(
    input: CallInput & { schema: ZodType<T> },
  ): Promise<ObjectResult<T> | null> {
    const nudged: CallInput = {
      ...input,
      messages: this.withJsonNudge(input.messages),
    };
    const result = await this.runChain(nudged);
    if (!result) return null;

    // Reasoning models (Ring 2.6 1T, DeepSeek-R1, etc.) often wrap the
    // final JSON in markdown fences, prefix it with a thinking blob, or
    // emit multiple `{...}` substrings. The naïve greedy regex below
    // captures the WRONG candidate when that happens. Walk every balanced
    // brace span instead, take the first one that schema-validates.
    const candidates = extractJsonCandidates(result.text);
    for (const candidate of candidates) {
      try {
        const parsedJson = JSON.parse(candidate);
        const parsed = input.schema.safeParse(parsedJson);
        if (parsed.success) {
          return {
            object: parsed.data,
            provider: result.providerId as LlmProvider,
            model: result.model,
            meta: result.meta,
          };
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  // Public to support callers that want exception semantics instead
  // of the `null`-on-failure contract. New code should prefer this.
  async generate(input: CallInput): Promise<TextResult> {
    const result = await this.runChain(input);
    if (!result) {
      throw new LlmProvidersExhaustedError(this.lastChainSummary);
    }
    return {
      text: result.text,
      provider: result.providerId as LlmProvider,
      model: result.model,
      meta: result.meta,
    };
  }

  // Snapshot of the last chain's per-provider outcome — populated by
  // `runChain` so `generate()` can attach it to the thrown error.
  private lastChainSummary: ProviderAttemptSummary[] = [];

  // ── Internal: provider chain orchestration ─────────────────────────

  private async runChain(input: CallInput): Promise<
    | {
        text: string;
        providerId: LlmProviderId;
        model: string;
        meta: CallMeta;
      }
    | null
  > {
    // Per-call provider override (`providerConfig`) bypasses the
    // fallback chain entirely — when a caller supplies an explicit
    // provider+key, we honor it as-is. Fallback would risk leaking the
    // tenant's prompt to a different upstream than they configured.
    if (input.providerConfig) {
      return this.runExplicit(input, input.providerConfig);
    }

    const chain = this.buildChain();
    const summaries: ProviderAttemptSummary[] = [];
    const providerChain: LlmProviderId[] = chain.map((p) => p.id);
    const timeoutMs = this.resolveTimeoutMs(input.timeoutMs);

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const isFallback = i > 0;

      if (!provider.isConfigured()) {
        summaries.push({
          provider: provider.id,
          reason: "unconfigured",
          status: null,
          message: "missing api key",
          attempts: 0,
        });
        continue;
      }

      // Quota check is per-provider — minimax has its own bucket, the
      // user might be over on minimax but still have headroom on openai.
      // Throws synchronously on deny; fail-open on infra error.
      await this.enforceQuota(input.messages, provider.id);

      const startedAt = Date.now();
      const request: ProviderCallRequest = {
        messages: input.messages,
        model: input.model,
        maxOutputTokens: input.maxOutputTokens,
        timeoutMs,
      };
      const outcome = await this.breaker.run(provider, request);

      if (outcome.kind === "success") {
        // If this is a fallback success, the *primary* call already
        // recorded as 'error'. Mark this row as 'fallback_used' so
        // dashboards can tell "we succeeded but degraded" apart from
        // a clean primary call.
        await this.recordCall({
          providerId: provider.id,
          model: outcome.result.model,
          startedAt,
          status: isFallback ? "fallback_used" : "success",
          errorReason: null,
          promptTokens: outcome.result.usage.promptTokens,
          completionTokens: outcome.result.usage.completionTokens,
          promptMessages: input.messages,
          responseText: outcome.result.text,
          responseMetadata: extractResponseMetadata(outcome.result.raw),
        });
        await this.commitQuotaUsage({
          providerId: provider.id,
          model: outcome.result.model,
          promptTokens: outcome.result.usage.promptTokens,
          completionTokens: outcome.result.usage.completionTokens,
        });
        summaries.push({
          provider: provider.id,
          reason: "exhausted", // unused on success path
          status: 200,
          message: null,
          attempts: outcome.attempts,
        });
        this.lastChainSummary = summaries;

        return {
          text: outcome.result.text,
          providerId: provider.id,
          model: outcome.result.model,
          meta: {
            fallbackUsed: isFallback,
            providerChain,
          },
        };
      }

      // Failure path — record + decide whether to continue. We still
      // capture the prompt so the trace endpoint can show "this is
      // what we tried to send when it failed"; responseText is null
      // since the provider never returned a usable body.
      await this.recordCall({
        providerId: provider.id,
        model: input.model ?? "(unknown)",
        startedAt,
        status: classifyFailureStatus(outcome.error),
        errorReason: outcome.error?.message ?? outcome.reason,
        promptTokens: 0,
        completionTokens: 0,
        promptMessages: input.messages,
        responseText: null,
        responseMetadata: null,
      });
      summaries.push({
        provider: provider.id,
        reason: outcome.reason,
        status: outcome.error?.status ?? null,
        message: outcome.error?.message ?? null,
        attempts: outcome.attempts,
      });

      if (outcome.reason === "non_retryable") {
        // 4xx other than 429: bail out of the chain entirely. We don't
        // want to try OpenAI when MiniMax just told us our schema is
        // invalid — same input would fail there too.
        this.lastChainSummary = summaries;
        return null;
      }
      // 5xx / timeout / circuit_open → keep walking the chain.
    }

    this.lastChainSummary = summaries;
    return null;
  }

  private async runExplicit(
    input: CallInput,
    config: LlmProviderConfig,
  ): Promise<
    | {
        text: string;
        providerId: LlmProviderId;
        model: string;
        meta: CallMeta;
      }
    | null
  > {
    const provider = this.providerForExplicitConfig(config);
    if (!provider) {
      return null;
    }
    // Explicit per-tenant config STILL enforces quota — the host can
    // own its own key but still be on the free tier. If they want
    // unmetered usage, an admin overrides the limit row directly.
    await this.enforceQuota(input.messages, provider.id);
    const timeoutMs = this.resolveTimeoutMs(input.timeoutMs);
    const startedAt = Date.now();
    const request: ProviderCallRequest = {
      messages: input.messages,
      model: input.model ?? config.model ?? undefined,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs,
      apiKeyOverride: config.apiKey,
      baseUrlOverride: config.baseUrl ?? undefined,
    };
    // Explicit config still flows through the breaker so we get retry
    // + timeout semantics. Per-tenant `custom` configs land in their
    // own provider id ('custom') so a flaky tenant proxy doesn't
    // poison the shared minimax/openai breaker buckets. Explicit
    // minimax/openai configs *do* share the bucket with the default
    // path — that's the right call: a key rotation gone wrong should
    // surface to ops even if a tenant set it explicitly.
    const outcome = await this.breaker.run(provider, request);
    if (outcome.kind === "success") {
      await this.recordCall({
        providerId: provider.id,
        model: outcome.result.model,
        startedAt,
        status: "success",
        errorReason: null,
        promptTokens: outcome.result.usage.promptTokens,
        completionTokens: outcome.result.usage.completionTokens,
        promptMessages: input.messages,
        responseText: outcome.result.text,
        responseMetadata: extractResponseMetadata(outcome.result.raw),
      });
      await this.commitQuotaUsage({
        providerId: provider.id,
        model: outcome.result.model,
        promptTokens: outcome.result.usage.promptTokens,
        completionTokens: outcome.result.usage.completionTokens,
      });
      this.lastChainSummary = [
        {
          provider: provider.id,
          reason: "exhausted",
          status: 200,
          message: null,
          attempts: outcome.attempts,
        },
      ];
      return {
        text: outcome.result.text,
        providerId: provider.id,
        model: outcome.result.model,
        meta: {
          fallbackUsed: false,
          providerChain: [provider.id],
        },
      };
    }
    await this.recordCall({
      providerId: provider.id,
      model: input.model ?? config.model ?? "(unknown)",
      startedAt,
      status: classifyFailureStatus(outcome.error),
      errorReason: outcome.error?.message ?? outcome.reason,
      promptTokens: 0,
      completionTokens: 0,
      promptMessages: input.messages,
      responseText: null,
      responseMetadata: null,
    });
    this.lastChainSummary = [
      {
        provider: provider.id,
        reason: outcome.reason,
        status: outcome.error?.status ?? null,
        message: outcome.error?.message ?? null,
        attempts: outcome.attempts,
      },
    ];
    return null;
  }

  // Build the primary→fallback chain from env. Skips providers that
  // aren't configured (no key) so callers don't have to.
  private buildChain(): LlmProviderInterface[] {
    const primaryId =
      this.configService.get<DefaultLlmProvider>("OPENKT_DEFAULT_LLM_PROVIDER") ??
      "minimax";
    const fallbackId =
      this.configService.get<DefaultLlmProvider>("OPENKT_FALLBACK_LLM_PROVIDER") ??
      "openai";

    const chain: LlmProviderInterface[] = [];
    const primary = this.providerFor(primaryId);
    if (primary && primary.isConfigured()) {
      chain.push(primary);
    }
    if (fallbackId !== primaryId) {
      const fallback = this.providerFor(fallbackId);
      if (fallback && fallback.isConfigured()) {
        chain.push(fallback);
      }
    }
    return chain;
  }

  private providerFor(id: DefaultLlmProvider): LlmProviderInterface | null {
    const cached = this.providerCache.get(id);
    if (cached) return cached;

    let provider: LlmProviderInterface | null = null;
    if (id === "minimax") {
      provider = new MinimaxProvider(this.configService);
    } else if (id === "openai") {
      // The primary OpenAI provider may target any OpenAI-compatible API,
      // including Amazon Bedrock Mantle. Honour the deployment-level route
      // and model overrides instead of silently falling back to OpenAI's
      // public endpoint and gpt-4o-mini. Do not apply primary-provider
      // overrides when OpenAI is only the fallback for another provider.
      const isPrimary =
        this.configService
          .get<string>("OPENKT_DEFAULT_LLM_PROVIDER")
          ?.trim() === "openai";
      provider = new OpenAiProvider(
        this.configService,
        isPrimary
          ? {
              baseUrlOverride:
                this.configService
                  .get<string>("OPENKT_DEFAULT_LLM_BASE_URL")
                  ?.trim() || undefined,
              modelOverride:
                this.configService
                  .get<string>("OPENKT_DEFAULT_LLM_MODEL")
                  ?.trim() || undefined,
            }
          : {},
      );
    } else if (id === "openrouter") {
      // OpenRouter speaks the OpenAI-compat protocol too, so we reuse
      // OpenAiProvider with the route override. Done inline to avoid
      // a third provider class for a single base-URL difference.
      // Env overrides take precedence over the hard-coded default —
      // otherwise OPENKT_DEFAULT_LLM_MODEL silently routes through the
      // paid default (claude-haiku-4.5) instead of the free model the
      // deployment asked for.
      provider = new OpenAiProvider(this.configService, {
        baseUrlOverride:
          this.configService.get<string>("OPENKT_DEFAULT_LLM_BASE_URL")?.trim() ||
          DEFAULTS.openrouter.baseUrl,
        modelOverride:
          this.configService.get<string>("OPENKT_DEFAULT_LLM_MODEL")?.trim() ||
          DEFAULTS.openrouter.model,
        apiKeyOverride:
          this.configService.get<string>("OPENKT_DEFAULT_LLM_KEY")?.trim() ||
          undefined,
      });
      // Override id to "openrouter" for accurate observability.
      (provider as unknown as { id: LlmProviderId }).id = "openrouter";
    }
    if (provider) {
      this.providerCache.set(id, provider);
    }
    return provider;
  }

  private providerForExplicitConfig(
    config: LlmProviderConfig,
  ): LlmProviderInterface | null {
    if (config.provider === "custom") {
      if (!config.baseUrl) return null;
      // Custom provider: reuse OpenAI client with explicit base URL.
      const provider = new OpenAiProvider(this.configService, {
        baseUrlOverride: config.baseUrl,
        modelOverride: config.model ?? undefined,
        apiKeyOverride: config.apiKey,
      });
      (provider as unknown as { id: LlmProviderId }).id = "custom";
      return provider;
    }
    if (config.provider === "minimax") {
      return new MinimaxProvider(this.configService, {
        baseUrlOverride: config.baseUrl ?? undefined,
        apiKeyOverride: config.apiKey,
        modelOverride: config.model ?? undefined,
      });
    }
    if (config.provider === "openai") {
      return new OpenAiProvider(this.configService, {
        baseUrlOverride: config.baseUrl ?? undefined,
        apiKeyOverride: config.apiKey,
        modelOverride: config.model ?? undefined,
      });
    }
    if (config.provider === "openrouter") {
      const provider = new OpenAiProvider(this.configService, {
        baseUrlOverride: config.baseUrl ?? DEFAULTS.openrouter.baseUrl,
        apiKeyOverride: config.apiKey,
        modelOverride: config.model ?? DEFAULTS.openrouter.model,
      });
      (provider as unknown as { id: LlmProviderId }).id = "openrouter";
      return provider;
    }
    return null;
  }

  private resolveTimeoutMs(perCall?: number): number {
    if (typeof perCall === "number" && perCall > 0) return perCall;
    const envValue = this.configService.get<number | string>(
      "OPENKT_LLM_TIMEOUT_MS",
    );
    const parsed =
      typeof envValue === "number"
        ? envValue
        : typeof envValue === "string"
        ? Number(envValue)
        : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return DEFAULT_TIMEOUT_MS;
  }

  // Throws LlmQuotaExceededError when the user is over their cap.
  // Returns normally (no-op) when:
  //   - no quota checker is bound (worker/server isn't configured)
  //   - no `userId` is in the AsyncLocalStorage context (system call)
  //   - the checker errors (fail-open — quota infra must never take
  //     down the LLM surface; better to over-serve than blanket-deny)
  private async enforceQuota(
    messages: LlmMessage[],
    providerId: LlmProviderId,
  ): Promise<void> {
    if (!this.quotaChecker) return;
    const ctx = getLlmCallContext();
    const userId = ctx?.userId;
    if (!userId) return;

    const estimatedTokens = this.estimatePromptTokens(messages);
    let result: LlmQuotaCheckResult;
    try {
      result = await this.quotaChecker.checkAndReserve({
        userId,
        provider: providerId,
        estimatedTokens,
      });
    } catch (err) {
      // Fail-open: a quota DB hiccup should NOT block traffic.
      this.logger.warn(
        `[quota] checkAndReserve failed user=${userId} provider=${providerId} — failing open: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (result.allowed) return;
    // Surface a quota_exceeded row so the trace endpoint shows the
    // miss even though we never hit the provider. Best-effort; if the
    // recorder is unbound or the write fails, we still throw.
    await this.recordCall({
      providerId,
      model: "(quota_blocked)",
      startedAt: Date.now(),
      status: "quota_exceeded",
      errorReason: result.reason ?? "quota_exceeded",
      promptTokens: 0,
      completionTokens: 0,
      promptMessages: messages,
      responseText: null,
      responseMetadata: null,
    });
    throw new LlmQuotaExceededError({
      provider: providerId,
      tokensLimit: result.tokensLimit ?? null,
      tokensRemaining: result.tokensRemaining ?? null,
      resetAt: result.resetAt ?? null,
      reason: result.reason ?? "quota_exceeded",
    });
  }

  // After a successful provider call, debit the actual token cost
  // against the user's bucket. Best-effort — same fail-open rule as
  // `enforceQuota` so a stuck DB doesn't crash the call path.
  private async commitQuotaUsage(args: {
    providerId: LlmProviderId;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }): Promise<void> {
    if (!this.quotaChecker) return;
    const ctx = getLlmCallContext();
    const userId = ctx?.userId;
    if (!userId) return;

    try {
      const costUsd = computeCostUsd(
        args.providerId as LlmProvider,
        args.model,
        args.promptTokens,
        args.completionTokens,
      );
      await this.quotaChecker.commitUsage({
        userId,
        provider: args.providerId,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        costUsd,
      });
    } catch (err) {
      this.logger.warn(
        `[quota] commitUsage failed user=${userId} provider=${args.providerId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 1 token ≈ 4 chars is the rule-of-thumb OpenAI's docs recommend
  // for the gpt family; MiniMax M2.x is BPE-flavored similar enough
  // that we use the same heuristic for the pre-call reservation.
  // The real token count comes back from the provider response and is
  // what we commit on the success path — the estimate is only used
  // to gate "is there roughly room for this call at all".
  private estimatePromptTokens(messages: LlmMessage[]): number {
    let totalChars = 0;
    for (const m of messages) {
      totalChars += (m.content?.length ?? 0) + 4; // role overhead
    }
    return Math.max(1, Math.ceil(totalChars / 4));
  }

  // Recording is best-effort. Any failure (no recorder bound, DB hiccup,
  // worker still booting) must NOT propagate out of the gateway — the
  // contract with callers is "null on failure", never throw.
  private async recordCall(args: {
    providerId: LlmProviderId;
    model: string;
    startedAt: number;
    status: LlmCallRecordInput["status"];
    errorReason: string | null;
    promptTokens: number;
    completionTokens: number;
    promptMessages?: LlmMessage[];
    responseText?: string | null;
    responseMetadata?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!this.recorder) return;
    try {
      const latencyMs = Math.max(0, Date.now() - args.startedAt);
      const costUsd = computeCostUsd(
        args.providerId as LlmProvider,
        args.model,
        args.promptTokens,
        args.completionTokens,
      );
      await this.recorder.record({
        provider: args.providerId,
        model: args.model,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        latencyMs,
        status: args.status,
        errorReason: args.errorReason ?? null,
        costUsd,
        promptMessages: args.promptMessages,
        responseText: args.responseText ?? null,
        responseMetadata: args.responseMetadata ?? null,
      });
    } catch {
      // swallow — observability MUST NOT take down the call path
    }
  }

  private withJsonNudge(messages: LlmMessage[]): LlmMessage[] {
    const result = [...messages];
    const firstSystemIndex = result.findIndex((message) => message.role === "system");

    if (firstSystemIndex >= 0) {
      result[firstSystemIndex] = {
        role: "system",
        content: `${result[firstSystemIndex].content}${JSON_ONLY_NUDGE}`,
      };
      return result;
    }

    return [{ role: "system", content: JSON_ONLY_NUDGE }, ...result];
  }
}

// Exported so tests (or callers without DI) can grab the context that
// the recorder would observe in production.
export function currentLlmCallContext() {
  return getLlmCallContext();
}

function classifyFailureStatus(
  err: ProviderError | null,
): LlmCallRecordInput["status"] {
  if (!err) return "error";
  if (err.status === 429) return "rate_limited";
  if (err.status === 402 || err.status === 403) return "quota_exceeded";
  if (err.status === 408 || err.status === 504) return "timeout";
  if (err.code === "timeout") return "timeout";
  return "error";
}

// Plucks the small, dashboard-relevant subset of fields off the provider's
// raw response body. Every chat-completions-compat provider returns the
// same OpenAI-shaped object (`id`, `model`, `usage`, `choices[0].finish_reason`),
// so the worker can store one consistent metadata blob without bloating
// llm_calls with vendor-specific noise. Returns null when the raw body
// isn't an object — the recorder writes NULL into response_metadata.
function extractResponseMetadata(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  if (typeof obj.id === "string") metadata.id = obj.id;
  if (typeof obj.model === "string") metadata.model = obj.model;
  if (obj.usage && typeof obj.usage === "object") metadata.usage = obj.usage;
  const choices = Array.isArray(obj.choices) ? obj.choices : null;
  if (choices && choices[0] && typeof choices[0] === "object") {
    const finishReason = (choices[0] as Record<string, unknown>).finish_reason;
    if (typeof finishReason === "string") metadata.finish_reason = finishReason;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

// Extract every balanced `{...}` substring from raw LLM text in order
// of size (largest first). Reasoning models can emit:
//   * ```json ... ``` fences (we ignore — JSON.parse handles raw content)
//   * leading thinking text or scratch JSON blobs
//   * the actual answer either embedded or trailing
// Caller tries each candidate against the schema; the first one that
// passes wins. Returns [] if no balanced braces found.
function extractJsonCandidates(raw: string): string[] {
  // Strip common code fences. Multiple variants because reasoning
  // models are inconsistent.
  const cleaned = raw
    .replace(/```json\s*\n?/gi, "")
    .replace(/```\s*\n?/g, "")
    .trim();

  const candidates: string[] = [];
  // Walk and collect every balanced object span. Handles strings
  // (skips braces inside `"..."`) and escapes.
  const text = cleaned;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  // Try the largest spans first — the wrapping object is typically
  // the final answer; nested objects appear inside it.
  return candidates.sort((a, b) => b.length - a.length);
}
