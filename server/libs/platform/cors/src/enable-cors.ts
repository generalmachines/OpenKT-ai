import type { INestApplication } from "@nestjs/common";

import { parseAllowedOrigins } from "./origins";

// Headers the dashboard and CLI legitimately send. `X-Request-Id` is set
// by the BFF middleware on the way out and is also accepted on the way
// in for end-to-end correlation.
const ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Request-Id",
];

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

interface CorsEnv {
  CORS_ALLOWED_ORIGINS?: string;
}

export interface EnableCorsOptions {
  // Pass an explicit env object (typically `process.env` or a validated
  // schema) so tests can drive the config without mutating real env.
  env?: CorsEnv;
}

export function enableCorsFromEnv(
  app: INestApplication,
  options: EnableCorsOptions = {},
): void {
  const env = options.env ?? (process.env as CorsEnv);
  const allowed = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

  app.enableCors({
    origin(
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ): void {
      // Same-origin requests (server-to-server, curl, server-rendered
      // dashboard) have no Origin header — let them through; the
      // browser-only contract is the one we're guarding.
      if (!requestOrigin) {
        callback(null, true);
        return;
      }
      callback(null, allowed.includes(requestOrigin));
    },
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
  });
}
