// Shared OpenAI-compatible Chat Completions client.
//
// Both MiniMax (`api.minimax.villamarket.ai/v1`) and OpenAI itself
// (`api.openai.com/v1`) speak the same wire format, so the actual
// fetch + timeout + error-classification lives here. The two provider
// classes wrap it with their resolved defaults (base URL, key, model).

import {
  ProviderCallRequest,
  ProviderCallResult,
  ProviderError,
  LlmProviderId,
} from "./provider";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }> | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenAiCompatCallParams {
  providerId: LlmProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  request: ProviderCallRequest;
  defaultMaxOutputTokens: number;
}

export async function callOpenAiCompat(
  params: OpenAiCompatCallParams,
): Promise<ProviderCallResult> {
  const { providerId, baseUrl, apiKey, model, request } = params;

  // `AbortSignal.timeout` produces an `AbortError`/`TimeoutError` that
  // we catch below; the upstream `fetch` rejection propagates as a
  // ProviderError with status=0 so the breaker treats it as transient.
  const signal = AbortSignal.timeout(request.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: 0.1,
        max_tokens: request.maxOutputTokens ?? params.defaultMaxOutputTokens,
      }),
      signal,
    });
  } catch (err) {
    // Network failure / abort / timeout — all transient.
    throw new ProviderError({
      providerId,
      message: errorMessage(err),
      status: 0,
      retryable: true,
      code: isAbortError(err) ? "timeout" : networkErrorCode(err),
    });
  }

  // Defensive: a stubbed fetch in a test can resolve to undefined.
  // Treat that as a transient network glitch, not a bug, so retries
  // run and the breaker can account for it.
  if (!response || typeof response !== "object") {
    throw new ProviderError({
      providerId,
      message: "fetch returned no response",
      status: 0,
      retryable: true,
      code: "no_response",
    });
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = (await response.text()).slice(0, 240);
    } catch {
      // ignore
    }
    throw new ProviderError({
      providerId,
      message: `${providerId} ${response.status}: ${bodyText || response.statusText}`,
      status: response.status,
      retryable: isRetryableHttpStatus(response.status),
      code: `http_${response.status}`,
    });
  }

  let body: ChatCompletionResponse;
  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch (err) {
    // Not retryable — provider returned malformed JSON.
    throw new ProviderError({
      providerId,
      message: `invalid_json: ${errorMessage(err)}`,
      status: 200,
      retryable: false,
      code: "invalid_json_body",
    });
  }

  const text = extractText(body);
  if (!text) {
    throw new ProviderError({
      providerId,
      message: "empty_response",
      status: 200,
      retryable: false,
      code: "empty_response",
    });
  }

  return {
    text,
    usage: {
      promptTokens: numeric(body.usage?.prompt_tokens),
      completionTokens: numeric(body.usage?.completion_tokens),
    },
    model,
    raw: body,
  };
}

function isRetryableHttpStatus(status: number): boolean {
  // 5xx + 429 are transient and worth retrying / opening the circuit
  // breaker on. 408 is request-timeout — also retry.
  if (status >= 500 && status < 600) return true;
  if (status === 429 || status === 408) return true;
  return false;
}

function networkErrorCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === "string") return cause.code;
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 240);
  if (typeof err === "string") return err.slice(0, 240);
  return "unknown_error";
}

function extractText(response: ChatCompletionResponse): string | null {
  const message = response.choices?.[0]?.message;
  if (!message) return null;

  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const joined = message.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (joined.length > 0) return joined;
  }
  if (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content.trim().length > 0
  ) {
    return message.reasoning_content.trim();
  }
  return null;
}

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}
