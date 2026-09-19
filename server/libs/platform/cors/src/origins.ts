// Browser sign-in calls /v1/auth/* with `credentials: "include"`. The
// preflight has to advertise an exact origin (the wildcard `*` is
// disallowed when credentials are involved), so we keep an explicit
// allowlist parsed from `CORS_ALLOWED_ORIGINS` (comma-separated).
//
// Defaults cover the two surfaces a developer hits during local work:
// the dashboard at http://localhost:5273 and the same dashboard reached
// by loopback address. Production overrides this with the
// public app origin (e.g. https://app.openkt.ai).
export const DEFAULT_DEV_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:5273",
  "http://127.0.0.1:5273",
];

export function parseAllowedOrigins(
  raw: string | undefined,
  defaults: readonly string[] = DEFAULT_DEV_ALLOWED_ORIGINS,
): string[] {
  if (raw === undefined) return [...defaults];
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : [...defaults];
}
