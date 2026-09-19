// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0
import { LlmConfigError, LlmTransportError } from "./errors.js";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, Usage } from "./types.js";

export interface OpenAiClientConfig {
  /** Up to and including the version segment, e.g. "http://localhost:8080/v1". */
  baseUrl: string;
  apiKey?: string;
  /** Default "qwen3.5-4b". */
  model?: string;
  /** Default 0. */
  temperature?: number;
  /** Default 2048; an agent's own maxTokens wins. */
  maxTokens?: number;
  /**
   * How to ask for structured output. "json_schema" (default) is constrained decoding;
   * "json_object" and "none" are for runtimes that reject it — the schema is in the prompt either way.
   */
  responseFormat?: "json_schema" | "json_object" | "none";
  /**
   * Send `chat_template_kwargs: {enable_thinking: false}` (vLLM, SGLang, llama.cpp, mlx servers).
   * Default true. Turn off for endpoints that reject unknown fields (api.openai.com).
   */
  disableThinkingKwarg?: boolean;
  /** Prepend "/no_think" to the system message (Qwen3 soft switch). Default false. */
  noThinkPrefix?: boolean;
  /** Default 30 000 (Spec 02 §10). */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Merged into the request body last, for runtime-specific knobs. */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
}

export class OpenAiCompatibleClient implements LlmClient {
  private readonly url: string;
  private readonly cfg: OpenAiClientConfig;

  constructor(config: OpenAiClientConfig) {
    if (!config?.baseUrl || !/^https?:\/\//.test(config.baseUrl)) {
      throw new LlmConfigError(`baseUrl must be an http(s) URL, got ${JSON.stringify(config?.baseUrl)}`);
    }
    this.cfg = config;
    this.url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  /** The exact JSON body for a request. Public so it can be tested and mirrored in Swift. */
  buildBody(request: LlmRequest): Record<string, unknown> {
    const cfg = this.cfg;
    const format = cfg.responseFormat ?? "json_schema";
    return {
      model: cfg.model ?? "qwen3.5-4b",
      temperature: cfg.temperature ?? 0,
      max_tokens: request.maxTokens ?? cfg.maxTokens ?? 2048,
      stream: false,
      messages: cfg.noThinkPrefix ? withNoThink(request.messages) : request.messages,
      ...(format === "json_schema"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: request.schema.name, schema: request.schema.schema, strict: true },
            },
          }
        : format === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
      ...(cfg.disableThinkingKwarg === false ? {} : { chat_template_kwargs: { enable_thinking: false } }),
      ...cfg.extraBody,
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const cfg = this.cfg;
    const timeout = AbortSignal.timeout(cfg.timeoutMs ?? 30_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await (cfg.fetch ?? fetch)(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...cfg.headers,
        },
        body: JSON.stringify(this.buildBody(request)),
        signal,
      });
    } catch (e) {
      throw new LlmTransportError(`request to ${this.url} failed: ${(e as Error).message}`);
    }

    const raw = await res.text().catch(() => "");
    if (!res.ok) throw new LlmTransportError(`${this.url} answered HTTP ${res.status}`, res.status, raw.slice(0, 2000));

    let body: { choices?: { message?: { content?: unknown } }[]; usage?: Partial<Usage> };
    try {
      body = JSON.parse(raw);
    } catch {
      throw new LlmTransportError(`${this.url} did not answer with JSON`, res.status, raw.slice(0, 2000));
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" && !Array.isArray(content)) {
      throw new LlmTransportError(`${this.url} answered without choices[0].message.content`, res.status, raw.slice(0, 2000));
    }
    const text =
      typeof content === "string"
        ? content
        : content.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("");

    const u = body.usage;
    const usage: Usage | undefined =
      u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number"
        ? {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens,
          }
        : undefined;
    return { text, ...(usage ? { usage } : {}) };
  }
}

function withNoThink(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) =>
    i === 0 && m.role === "system" && typeof m.content === "string" ? { ...m, content: `/no_think\n${m.content}` } : m,
  );
}

/** Builds a client from OPENKT_LLM_BASE_URL, OPENKT_LLM_API_KEY, OPENKT_LLM_MODEL and friends. */
export function clientFromEnv(env: Record<string, string | undefined> = process.env): OpenAiCompatibleClient {
  const baseUrl = env.OPENKT_LLM_BASE_URL;
  if (!baseUrl) throw new LlmConfigError("OPENKT_LLM_BASE_URL is not set");
  const format = env.OPENKT_LLM_RESPONSE_FORMAT;
  if (format && format !== "json_schema" && format !== "json_object" && format !== "none") {
    throw new LlmConfigError(`OPENKT_LLM_RESPONSE_FORMAT must be json_schema, json_object or none, got "${format}"`);
  }
  return new OpenAiCompatibleClient({
    baseUrl,
    apiKey: env.OPENKT_LLM_API_KEY || undefined,
    model: env.OPENKT_LLM_MODEL || undefined,
    responseFormat: format as OpenAiClientConfig["responseFormat"],
    disableThinkingKwarg: env.OPENKT_LLM_THINKING_KWARG !== "0",
    noThinkPrefix: env.OPENKT_LLM_NO_THINK_PREFIX === "1",
  });
}
