# OpenKT server tests

`test/unit` and `test/e2e` are jest suites (`npm run test:unit`, `npm run test:e2e`). This file covers `test/smoke`: repeatable curl-based checks against a running server.

## What is covered now

- API live/readiness health endpoints
- service-token auth path
- standard unauthorized error envelope
- optional Supabase-backed user auth if a bearer token or email/password is provided
- read-only memory routes
- optional user settings DB round-trip against a real Supabase-backed account

## Commands

Run all checkpoint smokes:

```bash
npm run test:smoke
```

The default checkpoint suite covers the reliable path:
- health
- service-token auth
- error envelope
- optional Supabase JWT auth
- read-only memory routes

Run the optional authenticated smoke with a real bearer token:

```bash
OPENKT_TEST_BEARER_TOKEN=<jwt> npm run test:smoke:optional-auth
```

Run the optional authenticated smoke by minting a JWT from email/password:

```bash
OPENKT_TEST_EMAIL=<email> OPENKT_TEST_PASSWORD=<password> npm run test:smoke:optional-auth
```

Run the DB-backed user-settings round-trip:

```bash
OPENKT_TEST_EMAIL=<email> OPENKT_TEST_PASSWORD=<password> npm run test:smoke:user-settings
```

Keep `user-settings-roundtrip.sh` as a separate manual smoke. It touches persisted settings state and is intentionally not part of `npm run test:smoke`.

Run the read-only memory smoke:

```bash
OPENKT_TEST_EMAIL=<email> OPENKT_TEST_PASSWORD=<password> npm run test:smoke:memory-read
```

## Notes

- Scripts live under `test/smoke/`.
- `test/fixtures/api.env` is a local non-secret env file for booting the API in smoke mode.
- The smoke helper prefers the repo root env files first: `../.env.local`, then `../.env`.
- If no repo-root env exists, it falls back to `api/.env.local`, then `api/.env`, then the fixture env.
- The optional authenticated smoke still depends on real Supabase connectivity and a valid JWT.
