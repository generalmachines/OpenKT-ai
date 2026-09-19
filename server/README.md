# OpenKT server

The OpenKT backend: a shared context store for a team's AI tools. It exposes
a REST API and an MCP endpoint, keeps everything in Postgres (pgvector for
similarity, `tsvector` for keywords), and enforces who can read what inside
the search query itself.

Two processes are built from this directory:

- **server** (`apps/server`) — the HTTP API under `/v1/*`, the MCP endpoint at
  `/mcp`, and the OAuth 2.1 endpoints for MCP clients.
- **worker** (`apps/worker`) — background processing of saved context
  (embedding, de-duplication, grouping, briefs).

It is a standalone NestJS + Drizzle project with its own `package.json` and
lockfile. It is **not** part of the repository's npm workspaces — run every
command from `server/`.

The product and its contract are described in `../docs/product.md`,
`../docs/architecture.md` and `../docs/specs/04-api-contract.md`.

## Run it

You need Node 20+ and a Postgres 16 with the `pgvector` extension:

```bash
docker run -d --name openkt-postgres \
  -e POSTGRES_USER=openkt -e POSTGRES_PASSWORD=openkt -e POSTGRES_DB=openkt \
  -p 15432:5432 pgvector/pgvector:pg16
```

Then:

```bash
cd server
npm ci
cp .env.example .env        # set DATABASE_URL and the values described below
npm run db:migrate
npm run start:api:dev       # http://localhost:4100  (health: GET /v1/health)
npm run start:worker:dev    # optional — background processing
```

Configuration is validated at boot; a missing or invalid variable stops the
process with a message naming it. Every variable is declared in
`libs/platform/config/src/env.schemas.ts` and listed in `.env.example`. The
ones you must set:

| Variable | Used for |
|---|---|
| `DATABASE_URL` | Postgres with pgvector. |
| `RABBITMQ_URL` | The worker's queue when `OPENKT_QUEUE_BACKEND=rabbitmq` (the default). `OPENKT_QUEUE_BACKEND=sqs` uses Amazon SQS instead and needs `AWS_REGION` and `OPENKT_SQS_COMMAND_QUEUE_URL`. |

Sign-in is built in — email + password works with nothing configured
(`POST /v1/auth/signup`, `/v1/auth/login`; a session is an `okt_pat_…` access
token). See the Auth section of `docs/specs/04-api-contract.md`.

Optional, and degrading cleanly when unset:

| Variable | Used for |
|---|---|
| `OPENKT_GOOGLE_CLIENT_IDS` | Comma-separated Google OAuth client ids. Turns on Google sign-in (`POST /v1/auth/google`). |
| `OPENKT_TRUST_PROXY` | Express `trust proxy` (e.g. `1`). Set it behind a reverse proxy so the per-address sign-in limit sees real client addresses. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase sign-in, as an additional provider (all three or none). Authentication only; no product data lives there. |
| `OPENKT_BGE_URL` (or `OPENKT_EMBEDDING_BACKEND=openai` + `OPENAI_API_KEY`) | Embeddings. Without them recall falls back to keyword search. |
| `OPENKT_RERANK_URL` | A TEI/Cohere-style `/rerank` endpoint applied to the fused results. |
| `OPENKT_DEFAULT_LLM_PROVIDER`, `OPENKT_DEFAULT_LLM_KEY`, `OPENKT_DEFAULT_LLM_BASE_URL`, `OPENKT_DEFAULT_LLM_MODEL` | The generation model (any OpenAI-compatible endpoint) used by the worker and the capture endpoint. |
| `CORS_ALLOWED_ORIGINS` | Browser origins allowed to call the API with credentials. |

## Test it

```bash
npm run typecheck
npm run test:unit
DATABASE_URL=postgres://openkt:openkt@127.0.0.1:15432/openkt npm run test:e2e
```

Tests that need a database skip themselves when `DATABASE_URL` is unset. Run
`npm run db:migrate` against that database first.

`test/e2e/proof-context-cloud-v0.1.e2e-spec.ts` is the product's promise in
executable form — something one person saved reaches a teammate who has been
granted access, and nobody else. It must always pass.

`npm run test:smoke` runs curl-based checks against a running server; see
`test/README.md`.

`npm run openapi:generate` boots the application and writes
`docs/openapi/server.v1.json`.

## Where things live

`WHERE_THINGS_LIVE.md` maps every concept (sessions, facts, recall, grants,
MCP tools, migrations, environment variables) to its path, and lists the rules
that are easy to break — start there before changing anything.

```
apps/server/src/modules/<name>/   one feature each: controllers, services, contracts, repositories
apps/server/src/db/               Drizzle schema and SQL migrations (append-only)
apps/worker/src/modules/          queue consumers, pipeline stages, outbox relay
libs/                             shared code: auth, config, errors, logging, LLM gateway
test/unit · test/e2e · test/smoke
```
