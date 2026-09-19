import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { Response } from "express";

import {
  DomainError,
  ForbiddenDomainError,
  GoneDomainError,
  NotFoundDomainError,
  UnauthorizedDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";
import {
  LlmProvidersExhaustedError,
  LlmQuotaExceededError,
} from "@openkt/platform-llm";
import { ProviderError } from "@openkt/platform-llm";

import type { RequestWithContext } from "../http/request-with-context";

// Single point of egress for ALL errors leaving the BFF.
//
// Responsibilities:
//   1. Map every Throwable to a stable `{ status, code, message, details }`
//      with codes the CLI/dashboard branch on. No "http_exception"
//      passthrough — that's a signal the caller didn't classify.
//   2. Log every error path with structured context. 5xx and unknown
//      paths log at error level with a stack; expected 4xx log at
//      warn/debug without stack noise.
//   3. Surface upstream-system failures (LLM provider, DB, RabbitMQ,
//      network) as their own codes so the dashboard can tell "user
//      typed wrong password" from "OpenRouter returned 503."
//
// Side rules:
//   - Never include secrets in `details`. We log + return the upstream
//     status code + provider id, not API keys.
//   - `details` returned to the client is a structured object the
//     caller can rely on; we don't dump raw `error.cause` chains.

interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details: unknown;
  // What to log at. Default 5xx=error, 4xx=warn, 400/422=debug. Set
  // explicitly when the heuristic would be wrong (e.g. quota-exceeded
  // is a 429 but worth a warn log for ops).
  logLevel: "error" | "warn" | "debug";
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();

    const requestId =
      request.requestMetadata?.requestId ??
      (request.headers["x-request-id"] as string | undefined) ??
      null;

    const normalized = this.normalizeError(exception);
    this.logIt(normalized, exception, request, requestId);

    // ── GAP 2: RFC 9728 §5 WWW-Authenticate on /mcp 401s ─────────────
    // MCP clients discover the auth server by reading the
    // WWW-Authenticate header on the first unauthenticated request.
    // Without it they have no machine-readable way to find
    // /.well-known/oauth-protected-resource. Scoped to /mcp only so we
    // don't blanket-add the header to every 401 in the API.
    if (
      normalized.status === HttpStatus.UNAUTHORIZED &&
      isMcpPath(request.originalUrl ?? request.url ?? "")
    ) {
      const proto =
        (request.headers["x-forwarded-proto"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ??
        request.protocol ??
        "http";
      const host =
        (request.headers["x-forwarded-host"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ??
        (request.get ? request.get("host") : null) ??
        "localhost";
      const origin = `${proto}://${host}`;
      // /v1/mcp (legacy alias) is its own resource, with its own metadata
      // (RFC 9728 §3.1 path-suffixed); /mcp keeps the root document.
      const path = (request.originalUrl ?? request.url ?? "").split("?")[0] ?? "";
      const metadataPath = path.startsWith("/v1/mcp")
        ? "/.well-known/oauth-protected-resource/v1/mcp"
        : "/.well-known/oauth-protected-resource";
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}${metadataPath}"`);
    }

    // ── RFC 7591 / RFC 6749 bare-error shape for /oauth/* ──
    // MCP clients (Cursor, VS Code, Claude.ai) parse OAuth errors per
    // the RFCs: `{ error: "<code>", error_description: "<msg>" }` at
    // the top level, NOT wrapped in our `{ data, error, meta }`
    // envelope. The unwrap path (filter.normalizeError → details holds
    // the structured payload from `new HttpException({error, error_description}, …)`)
    // gives us the original RFC fields back; emit them raw here.
    const url = request.originalUrl ?? request.url ?? "";
    const isOauth =
      url.startsWith("/oauth/") || url.startsWith("/.well-known/oauth-");
    if (isOauth) {
      const details = (normalized.details ?? {}) as Record<string, unknown>;
      const rfcError =
        typeof details.error === "string" ? (details.error as string) : null;
      const rfcDescription =
        typeof details.error_description === "string"
          ? (details.error_description as string)
          : null;
      response.status(normalized.status).json({
        error: rfcError ?? mapToRfcOauthError(normalized.code),
        error_description: rfcDescription ?? normalized.message,
      });
      return;
    }

    response.status(normalized.status).json({
      data: null,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
        request_id: requestId,
      },
      meta: null,
    });
  }

  private normalizeError(exception: unknown): NormalizedError {
    // ── LLM gateway ───────────────────────────────────────────────────
    if (exception instanceof LlmQuotaExceededError) {
      const usedFallback =
        exception.tokensLimit != null && exception.tokensRemaining != null
          ? Math.max(0, exception.tokensLimit - exception.tokensRemaining)
          : null;
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: "quota_exceeded",
        message: "Free tier limit reached for this billing period",
        details: {
          tokens_limit: exception.tokensLimit,
          tokens_used: exception.tokensUsed ?? usedFallback,
          tokens_remaining: exception.tokensRemaining,
          reset_at: exception.resetAt
            ? exception.resetAt.toISOString()
            : null,
          provider: exception.provider,
          reason: exception.reason,
        },
        logLevel: "warn",
      };
    }
    if (exception instanceof LlmProvidersExhaustedError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: "upstream_llm_unavailable",
        message:
          "All configured LLM providers failed to respond. Try again shortly or contact support.",
        details: {
          attempts: exception.attempts.map((a) => ({
            provider: a.provider,
            reason: a.reason,
            status: a.status,
            // upstream error text is safe to surface — providers never
            // echo API keys in error bodies.
            message: a.message,
            attempts: a.attempts,
          })),
        },
        logLevel: "error",
      };
    }
    if (exception instanceof ProviderError) {
      return {
        status:
          exception.status >= 400 && exception.status < 600
            ? HttpStatus.BAD_GATEWAY
            : HttpStatus.SERVICE_UNAVAILABLE,
        code: "upstream_llm_failed",
        message: `LLM provider ${exception.providerId} failed: ${exception.message}`,
        details: {
          provider: exception.providerId,
          upstream_status: exception.status,
          retryable: exception.retryable,
          code: exception.code,
        },
        logLevel: "error",
      };
    }

    // ── Domain errors (controllers throw these) ───────────────────────
    if (exception instanceof ValidationDomainError) {
      return domainEnvelope(exception, HttpStatus.BAD_REQUEST, "debug");
    }
    if (exception instanceof UnauthorizedDomainError) {
      return domainEnvelope(exception, HttpStatus.UNAUTHORIZED, "warn");
    }
    if (exception instanceof ForbiddenDomainError) {
      return domainEnvelope(exception, HttpStatus.FORBIDDEN, "warn");
    }
    if (exception instanceof NotFoundDomainError) {
      return domainEnvelope(exception, HttpStatus.NOT_FOUND, "debug");
    }
    if (exception instanceof GoneDomainError) {
      return domainEnvelope(exception, HttpStatus.GONE, "warn");
    }
    if (exception instanceof DomainError) {
      return domainEnvelope(exception, HttpStatus.INTERNAL_SERVER_ERROR, "error");
    }

    // ── Nest HttpException — unwrap structured payload so we don't ────
    //    surface `code: "http_exception"`. Controllers that throw
    //    `new ForbiddenException({code, message, ...})` get their inner
    //    code propagated through.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const unwrapped = unwrapHttpExceptionPayload(payload, exception.message);
      return {
        status,
        code: unwrapped.code,
        message: unwrapped.message,
        details: unwrapped.details,
        logLevel: status >= 500 ? "error" : status >= 400 ? "warn" : "debug",
      };
    }

    // ── Postgres errors (node-postgres rethrows with .code) ───────────
    const pg = asPgError(exception);
    if (pg) return pg;

    // ── Common Node network errors ────────────────────────────────────
    const net = asNetworkError(exception);
    if (net) return net;

    // ── Fallback: opaque 500 with the raw message logged but not  ──────
    //    in the response. Never echo arbitrary stacks back to clients.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: "internal_error",
      message: "An unexpected error occurred. The team has been notified.",
      details: null,
      logLevel: "error",
    };
  }

  private logIt(
    normalized: NormalizedError,
    exception: unknown,
    request: RequestWithContext,
    requestId: string | null,
  ): void {
    const principalId =
      request.actorContext?.principal.userId ??
      request.actorContext?.principal.serviceName ??
      "anonymous";

    const base = {
      request_id: requestId,
      method: request.method,
      url: stripQuery(request.originalUrl ?? request.url ?? ""),
      principal: principalId,
      status: normalized.status,
      code: normalized.code,
    };

    const message = `[${normalized.status} ${normalized.code}] ${normalized.message}`;

    if (normalized.logLevel === "error") {
      // No-op when Sentry.init never ran (missing/placeholder DSN).
      Sentry.captureException(
        exception instanceof Error
          ? exception
          : new Error(safeStringify(exception)),
        { extra: { ...base } },
      );
      const stack =
        exception instanceof Error
          ? exception.stack ?? exception.message
          : safeStringify(exception);
      this.logger.error(
        {
          ...base,
          details: normalized.details,
          err_name: exception instanceof Error ? exception.name : typeof exception,
        },
        `${message}\n${stack}`,
      );
      return;
    }
    if (normalized.logLevel === "warn") {
      this.logger.warn(base, message);
      return;
    }
    this.logger.debug(base, message);
  }
}

function domainEnvelope(
  exception: DomainError,
  status: number,
  logLevel: NormalizedError["logLevel"],
): NormalizedError {
  return {
    status,
    code: exception.code,
    message: exception.message,
    details: exception.details,
    logLevel,
  };
}

// Internal `code` field → RFC 6749 §5.2 / RFC 7591 §3.2.2 oauth error
// identifier. Anything we don't recognise as an OAuth-spec code falls
// back to "invalid_request" so the MCP client at least gets a valid
// RFC token to parse.
const RFC_OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_redirect_uri",
  "invalid_token",
  "unsupported_response_type",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);
function mapToRfcOauthError(code: string | null | undefined): string {
  if (code && RFC_OAUTH_ERROR_CODES.has(code)) return code;
  return "invalid_request";
}

function unwrapHttpExceptionPayload(
  payload: unknown,
  fallbackMessage: string,
): { code: string; message: string; details: unknown } {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const innerCode = typeof obj.code === "string" ? obj.code : null;
    const innerMessage = typeof obj.message === "string" ? obj.message : null;
    if (innerCode || innerMessage) {
      const { code: _c, message: _m, ...rest } = obj;
      return {
        code: innerCode ?? "http_exception",
        message: innerMessage ?? fallbackMessage,
        details: Object.keys(rest).length > 0 ? rest : null,
      };
    }
  }
  if (typeof payload === "string") {
    return { code: "http_exception", message: payload, details: null };
  }
  return { code: "http_exception", message: fallbackMessage, details: payload };
}

// node-postgres throws errors with `.code` (the 5-char SQLSTATE) and `.detail`.
// We classify the common ones so the client gets actionable codes.
function asPgError(exception: unknown): NormalizedError | null {
  if (!exception || typeof exception !== "object") return null;
  const err = exception as { code?: string; message?: string; detail?: string };
  if (typeof err.code !== "string" || err.code.length !== 5) return null;
  switch (err.code) {
    case "23505": // unique_violation
      return {
        status: HttpStatus.CONFLICT,
        code: "unique_violation",
        message: "A row with this key already exists.",
        details: { sqlstate: err.code, detail: err.detail ?? null },
        logLevel: "warn",
      };
    case "23503": // foreign_key_violation
      return {
        status: HttpStatus.CONFLICT,
        code: "foreign_key_violation",
        message: "Referenced row does not exist or is still in use.",
        details: { sqlstate: err.code, detail: err.detail ?? null },
        logLevel: "warn",
      };
    case "23502": // not_null_violation
      return {
        status: HttpStatus.BAD_REQUEST,
        code: "not_null_violation",
        message: "A required field was missing.",
        details: { sqlstate: err.code, detail: err.detail ?? null },
        logLevel: "warn",
      };
    case "57014": // statement_timeout
      return {
        status: HttpStatus.GATEWAY_TIMEOUT,
        code: "db_query_timeout",
        message: "The database query took too long to complete.",
        details: { sqlstate: err.code },
        logLevel: "error",
      };
    case "08000": // connection_exception
    case "08003": // connection_does_not_exist
    case "08006": // connection_failure
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: "db_unavailable",
        message: "The database is temporarily unavailable.",
        details: { sqlstate: err.code },
        logLevel: "error",
      };
  }
  return null;
}

function asNetworkError(exception: unknown): NormalizedError | null {
  if (!exception || typeof exception !== "object") return null;
  const err = exception as { code?: string; message?: string };
  switch (err.code) {
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "EHOSTUNREACH":
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: "upstream_unavailable",
        message: `Upstream service unreachable: ${err.code}`,
        details: { code: err.code },
        logLevel: "error",
      };
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return {
        status: HttpStatus.GATEWAY_TIMEOUT,
        code: "upstream_timeout",
        message: `Upstream service timed out: ${err.code}`,
        details: { code: err.code },
        logLevel: "error",
      };
  }
  return null;
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

// Returns true for any URL variant that routes to the MCP controller.
// The controller is mounted at /mcp (canonical) and also responds to
// /v1/mcp (legacy alias), so we match both.
function isMcpPath(url: string): boolean {
  const path = stripQuery(url);
  return path === "/mcp" || path === "/v1/mcp" || path.startsWith("/mcp/") || path.startsWith("/v1/mcp/");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
