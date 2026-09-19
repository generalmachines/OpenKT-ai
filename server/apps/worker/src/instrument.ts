import * as Sentry from "@sentry/node";

// Must be imported before anything else in main.ts so Sentry's default
// integrations (uncaught exception / unhandled rejection) hook first.
// A missing or placeholder DSN leaves the SDK uninitialized — every
// capture call is then a safe no-op.
const dsn = process.env.SENTRY_DSN;
if (dsn?.startsWith("https://")) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0,
  });
}
