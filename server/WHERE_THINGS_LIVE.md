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
| Grants, share by email | `modules/grants/` · tables `grants`, **`pending_grants`** (a share waiting for its email to sign up; converted in `GrantRepository.convertPendingForEmail`) |
| MCP tools and server instructions | `modules/mcp/services/mcp-server-factory.service.ts` |
| Sign-up, sign-in, sign-out (email + password, Google) | `modules/accounts/` — `POST /v1/auth/{signup,login,google,logout,password}`, `GET /v1/auth/providers` · tables **`user_credentials`, `login_attempts`** · hashing `services/password-hasher.ts` (Node scrypt) · limits `services/login-attempts.service.ts` |
| Sessions of signed-in people | there is no session table: a sign-in mints an access token named `session:<client>` through `modules/personal-tokens/` (table `personal_access_tokens`); logout revokes it |
| Token guard and scopes | `modules/auth/guards/bearer-auth.guard.ts` |
| Verifying someone else's JWTs (Google, Supabase) | `modules/auth/services/jwks-key-cache.ts` (shared key cache) + `modules/accounts/services/google-id-token-verifier.service.ts`, `modules/auth/services/supabase-jwt-verifier.service.ts` |
| Supabase sign-in (optional) | `modules/auth/` — routes under `/v1/auth/supabase/*`; off (404 `provider_disabled`) when `SUPABASE_URL` is unset |
| Environment variables (add new ones here) | `libs/platform/config/src/env.schemas.ts` and `.env.example` |
| Model calls | `libs/platform/llm/` (gateway + providers) |
| Embeddings client | `modules/memory/repositories/embedding-bge.ts` |
| Health probes | `modules/health/` (`GET /v1/health`), `modules/internal/` (`/v1/internal/health/*`, cron, pipeline debug) |
| Background worker | `apps/worker/src/modules/` |
| Tests | `test/unit/*.spec.ts`, `test/e2e/*.e2e-spec.ts` — the product's promise is `test/e2e/proof-context-cloud-v0.1.e2e-spec.ts`; it must always pass |

Rules that bite:
- **The server must boot with no `SUPABASE_*` variable set.** Never construct a Supabase client at module load or in a constructor; go through `SupabaseAdminClientFactory` (lazy) and check `isSupabaseConfigured()`. `test/e2e/built-in-accounts.e2e-spec.ts` boots the whole `AppModule` that way.
- Sign-in failures stay generic (`invalid_credentials`, one message) and rate-limit refusals never say which limit tripped. Do not add detail that reveals whether an email has an account. Emails of other people are returned only to a resource's owner.
- **Never name a table `sessions`.** Older databases already have an unrelated table with that name. Ours are `kt_sessions` and `kt_session_turns`.
- The database says `projects` and `memories`; the product says spaces and facts. Keep the database words in SQL and in API paths.
- Additive migrations only. Never edit a migration that has been merged.
- There is one memory engine, `LocalMemoryEngine` (plain Postgres: pgvector + `tsvector`, fused in SQL). `OPENKT_MEMORY_ENGINE` accepts only `local`.
- Removed features keep their tables: `memmachine_nodes`, `memory_external_refs`, `waitlist`, `project_code_graphs`, `org_secrets`, `service_health` still exist in the database (migrations are append-only) but have no Drizzle definition and no code. Do not reuse those names.
- To use `@openkt/pipeline`, `@openkt/recall` or `@openkt/agents` from here, add them as `"file:../packages/<name>"` dependencies and build that package first.
