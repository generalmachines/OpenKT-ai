import type { INestApplication } from "@nestjs/common";

import { parseAllowedOrigins } from "./origins";

// Two CORS policies.
//
// 1. Protocol routes — /mcp (and the /v1/mcp alias), /.well-known/*, and the
//    OAuth token / registration / revocation endpoints. Any MCP client may run
//    in a browser (claude.ai, ChatGPT, the MCP Inspector, browser agents), so
//    every origin is allowed. They authenticate with a bearer token or a PKCE
//    code, never a cookie, so no credentials are allowed and the answer is
//    `Access-Control-Allow-Origin: *`. The MCP headers are allowed, and
//    Mcp-Session-Id / WWW-Authenticate are exposed so a browser client can read
//    the session id and find the authorization server after a 401.
//    (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports,
//     …/basic/authorization)
//
// 2. Everything else (the REST API): only the origins in CORS_ALLOWED_ORIGINS,
//    with credentials. `*` in that list allows any origin (reflected, because
//    `*` cannot be combined with credentials).
//
// The sign-in page (/oauth/authorize) and the zero-install pages are plain
// HTML navigations and form posts; they get no CORS headers.

const ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "X-Request-Id",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Last-Event-ID",
];
const EXPOSED_HEADERS = ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate", "X-Request-Id"];
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const PREFLIGHT_MAX_AGE_SEC = 86_400;

interface CorsEnv {
  CORS_ALLOWED_ORIGINS?: string;
}

export interface EnableCorsOptions {
  env?: CorsEnv;
}

export function isProtocolPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return (
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path === "/v1/mcp" ||
    path.startsWith("/v1/mcp/") ||
    path.startsWith("/.well-known/") ||
    path === "/oauth/token" ||
    path === "/oauth/register" ||
    path === "/oauth/revoke"
  );
}

type CorsCallback = (err: Error | null, options?: Record<string, unknown>) => void;

export function enableCorsFromEnv(app: INestApplication, options: EnableCorsOptions = {}): void {
  const env = options.env ?? (process.env as CorsEnv);
  const allowed = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  const anyOrigin = allowed.includes("*");

  app.enableCors((req: { url?: string; originalUrl?: string }, callback: CorsCallback) => {
    if (isProtocolPath(req.originalUrl ?? req.url)) {
      callback(null, {
        origin: "*",
        credentials: false,
        methods: ALLOWED_METHODS,
        allowedHeaders: ALLOWED_HEADERS,
        exposedHeaders: EXPOSED_HEADERS,
        maxAge: PREFLIGHT_MAX_AGE_SEC,
      });
      return;
    }
    callback(null, {
      origin(requestOrigin: string | undefined, cb: (err: Error | null, allow?: boolean) => void): void {
        if (!requestOrigin) return cb(null, true);
        cb(null, anyOrigin || allowed.includes(requestOrigin));
      },
      credentials: true,
      methods: ALLOWED_METHODS,
      allowedHeaders: ALLOWED_HEADERS,
      exposedHeaders: EXPOSED_HEADERS,
    });
  });
}
