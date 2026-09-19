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
| Who can see what | `modules/access/access-scope.service.ts`, `libs/auth/authorization/src/access-policy.ts` · search authorises every id in `filters.project_ids` (one unreadable id → 404 for the whole request); the workspace ring (`ProjectScopeService.workspaceRing`) holds only spaces the caller can read on their own |
| Secrets refused on save (422 `contains_secret`) | `common/secrets/refuse-secrets.ts`, called on every save path (facts, session turns/title/summary, `/v1/capture`, skills) · `common/secrets/find-secrets.ts` is a verbatim copy of `packages/pipeline/src/secrets.ts`; `test/unit/find-secrets-sync.spec.ts` fails if they differ |
| Grants, share by email | `modules/grants/` · tables `grants`, **`pending_grants`** (a share waiting for its email to sign up; converted in `GrantRepository.convertPendingForEmail`) · resource types `project`, `session`, `skill` — a new one goes in `GrantRepository.findResourceOwner` and in both tables' `resource_type` CHECK |
| Skills (shared, versioned folders: a `SKILL.md` + optional text files) | `modules/skills/` — REST `/v1/skills`, access rules in `services/skills-application.service.ts`, folder limits + frontmatter parser `services/skill-files.ts`, the sign-up starter skill `services/starter-skill.ts` · tables **`skills`, `skill_versions`** (one immutable row per save), **`skill_runs`** · MCP tools `kt_list_skills`, `kt_get_skill`, `kt_save_skill` |
| Living pages (T2) and the space brief (T3) | `modules/pages/` — REST `GET /v1/projects/:id/pages` (meta.processing: sessions waiting for a Mac), `GET /v1/pages/:id` (citations numbered by source, who said it), `PUT /v1/pages/:id/sections/:sid` (a person's edit locks the section, writes a revision), `GET /v1/pages/:id/revisions`, `GET /v1/projects/:id/brief`; renderer `services/page-render.ts` · tables **`pages`, `page_sections`** (embedding + generated `tsv`), **`page_section_facts`, `page_revisions`, `briefs`** (migration 0044) · MCP `kt_page` (`modules/mcp/services/mcp-page-tools.ts`); `kt_session_start` carries the brief; recall returns sections in `meta.sections` |
| Background jobs, run on members' Macs | `modules/jobs/` — closing a session (or the idle sweep) queues `process_session`; a member's Mac claims it (`POST /v1/jobs/claim`, `FOR UPDATE SKIP LOCKED`, 5-minute lease, editor/owner of the space only), asks for neighbours and candidate pages (`/lookup`), runs the agents on its local model and posts `/complete`; `services/session-result.applier.ts` re-validates everything (quote gate, secrets, dedupe arithmetic, locked sections, citations from this space only) and saves facts as the session author's · the rules the server re-applies: `rules/living-rules.ts` (copies of `@openkt/pipeline` / `@openkt/agents` logic — the image builds from `server/` only) · table **`jobs`** · the Mac side: `apps/desktop/src/main/worker/` |
| Teams: spaces people join by link | `modules/teams/` — REST `POST/GET /v1/projects/:id/join-links`, `DELETE …/:code`, `POST /v1/join`, `GET /v1/join/:code/preview` · table **`join_links`** · joining creates an ordinary grant through `GrantsApplicationService.grantByJoinLink` · MCP tools `kt_create_team`, `kt_join_team`, `kt_invite_link` (`mcp/team-tools.ts`) |
| Zero-install pages on the API host | `modules/web/` — `GET /` → `/connect`, `/join/<code>`, `/connect` (server-rendered, cookie session = a 1-day `session:web` token, CSRF-checked forms); excluded from the `/v1` prefix in `main.ts`; the stylesheet is the OAuth sign-in page's (`oauth/views/sign-in-page.ts`) |
| MCP tools and server instructions | `modules/mcp/services/mcp-server-factory.service.ts` |
| MCP Apps cards (UI in claude.ai, Cowork, ChatGPT…) | `modules/mcp/services/mcp-card-tools.ts` (card tools + `ui://openkt/cards.html`), `mcp-apps.ts` (capability negotiation, spec links); the HTML is `../packages/mcp-cards/dist/openkt-cards.html` — rebuild it there and commit it |
| Sign-up, sign-in, sign-out (email + password, Google) | `modules/accounts/` — `POST /v1/auth/{signup,login,google,logout,password}`, `GET /v1/auth/providers` · tables **`user_credentials`, `login_attempts`** · hashing `services/password-hasher.ts` (Node scrypt) · limits `services/login-attempts.service.ts` (failed logins per email / per IP, sign-ups per IP; `OPENKT_AUTH_*`) |
| OAuth for MCP clients (discovery, DCR, sign-in page, token) | `modules/oauth/` — the sign-in + consent page is `views/sign-in-page.ts`, served by `controllers/authorize.controller.ts` (GET renders, POST signs in through `AccountsService`); CSRF in `services/oauth-form-token.service.ts` · tables `oauth_clients`, `oauth_authorization_codes`; issued tokens are rows in `personal_access_tokens` |
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
- JSON request bodies may be up to 3 MB (a skill carries up to 1 MB of text). The limit is set once in `main.ts` with `app.useBodyParser("json", …)` — globally, never on a path.
- There is one memory engine, `LocalMemoryEngine` (plain Postgres: pgvector + `tsvector`, fused in SQL). `OPENKT_MEMORY_ENGINE` accepts only `local`.
- Removed features keep their tables: `memmachine_nodes`, `memory_external_refs`, `waitlist`, `project_code_graphs`, `org_secrets`, `service_health` still exist in the database (migrations are append-only) but have no Drizzle definition and no code. Do not reuse those names.
- To use `@openkt/pipeline`, `@openkt/recall` or `@openkt/agents` from here, add them as `"file:../packages/<name>"` dependencies and build that package first.
