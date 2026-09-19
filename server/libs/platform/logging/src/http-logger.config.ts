import type { Params } from "nestjs-pino";

export function buildHttpLoggerConfig(serviceName: string): Params {
  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                singleLine: true,
                translateTime: "SYS:standard",
              },
            }
          : undefined,
      base: {
        service: serviceName,
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
      customProps: (req) => ({
        request_id: req.headers["x-request-id"] ?? null,
      }),
    },
  };
}
