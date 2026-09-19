# Server — where things live

This is the OpenKT API and worker (NestJS, Drizzle, Postgres + pgvector). It is **not** part of the root npm workspaces: it has its own `package.json` and lockfile. Work inside `server/`.

```
cd server
npm ci
cp .env.example .env                       # point DATABASE_URL at a Postgres with pgvector
npm run db:migrate
npm run typecheck
npm run test:unit
DATABASE_URL=postgres://… npm run test:e2e   # database tests skip themselves when DATABASE_URL is unset
```

| You need | Path |
|---|---|
| SQL migrations (append only) | `apps/server/src/db/migrations/NNNN_name.sql` + `meta/_journal.json` — the new journal entry's `when` must be larger than every existing one |
| Drizzle table definitions | `apps/server/src/db/schema/*.ts`, exported from `schema/index.ts` |
| A feature module (controller, service, contracts, repository) | `apps/server/src/modules/<name>/` — copy the layout of `modules/sessions/` |
| Sessions (T0) | `modules/sessions/` · tables **`kt_sessions`, `kt_session_turns`** |
| Facts (T1) — still called memories | `modules/memory/` · table `memories` (keyword column is **`content_tsv`**) |
| Recall (hybrid search, fusion, rerank hook) | `modules/memory/services/local-memory-engine.service.ts` (class `LocalMemoryEngine`, `search()`), `memory-recall.service.ts` |
| Who can see what | `modules/access/access-scope.service.ts`, `libs/auth/authorization/src/access-policy.ts` |
| Grants | `modules/grants/` · table `grants` |
| MCP tools and server instructions | `modules/mcp/services/mcp-server-factory.service.ts` |
| Token guard and scopes | `modules/auth/guards/bearer-auth.guard.ts` |
| Environment variables (add new ones here) | `libs/platform/config/src/env.schemas.ts` and `.env.example` |
| Model calls | `libs/platform/llm/` (gateway + providers) |
| Embeddings client | `modules/memory/repositories/embedding-bge.ts` |
| Health probes | `modules/health/` (`GET /v1/health`), `modules/internal/` (`/v1/internal/health/*`, cron, pipeline debug) |
| Background worker | `apps/worker/src/modules/` |
| Tests | `test/unit/*.spec.ts`, `test/e2e/*.e2e-spec.ts` — the product's promise is `test/e2e/proof-context-cloud-v0.1.e2e-spec.ts`; it must always pass |

Rules that bite:
- **Never name a table `sessions`.** Older databases already have an unrelated table with that name. Ours are `kt_sessions` and `kt_session_turns`.
- The database says `projects` and `memories`; the product says spaces and facts. Keep the database words in SQL and in API paths.
- Additive migrations only. Never edit a migration that has been merged.
- There is one memory engine, `LocalMemoryEngine` (plain Postgres: pgvector + `tsvector`, fused in SQL). `OPENKT_MEMORY_ENGINE` accepts only `local`.
- Removed features keep their tables: `memmachine_nodes`, `memory_external_refs`, `waitlist`, `project_code_graphs`, `org_secrets`, `service_health` still exist in the database (migrations are append-only) but have no Drizzle definition and no code. Do not reuse those names.
- To use `@openkt/pipeline`, `@openkt/recall` or `@openkt/agents` from here, add them as `"file:../packages/<name>"` dependencies and build that package first.
