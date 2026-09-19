# Production gap audit: what the clients call vs. what api.openkt.ai serves

2026-09-19. Every call below was made against production (`https://api.openkt.ai`, `https://mcp.openkt.ai/mcp`) with throwaway accounts (`infra-*@e2e.openkt.test`).

- **When the probes ran:** production was at `7307030`, then `81467ce`. Each row shows the last result, which was taken after #78 (security), #81 (MCP cards) and #86 (teams) were live.
- **Production now:** `1d8682a` (`GET /v1/meta`). It was deployed by CodeBuild `openkt-ai-deploy`.
- **Callers covered:**
  - `apps/desktop/src/api/http.ts` (data) and `auth.ts` (sign-in).
  - `apps/desktop/src/main/**`, which makes no OpenKT calls of its own: Google sign-in talks to Google, then the renderer posts the ID token.
  - `plugin/` (skill, commands, hooks), whose MCP server is `https://mcp.openkt.ai/mcp`.
  - `packages/mcp-cards`.
  - `docs/specs/04-api-contract.md` wherever it promises something a client relies on.

"Covered by" names the open branch or PR that closes the gap. "nobody" means no branch does yet.

## Gaps

| # | Caller | Call | Production | Contract / expectation | Covered by |
|---|---|---|---|---|---|
| 1 | plugin, Claude/ChatGPT connectors (**security**) | MCP `tools/call kt_create_team` / `kt_invite_link` / `kt_join_team` with a **read-only** PAT | **succeeds**: a read-scoped token created a team and an invite link. `kt_save_skill` did the same until #81 | a read-only token calling a write tool → 403 `insufficient_scope` | **this PR**: the scope check is deny-by-default (a tool must be listed read-only), so tools added later are safe |
| 2 | every PAT client | a write with a read-only PAT | 403 `forbidden` | 403 `insufficient_scope` | **this PR** |
| 3 | plugin `kt_recall`, desktop ⌘K | `POST /v1/memories/recall` and `kt_recall` **without** `project_id` | only the personal space is searched. A fact in a space shared with the caller (editor) is **not** found | Spec 04 `RecallItem.space`; the MCP instructions: "what one person saved should reach a teammate's session" | desktop: `qa/e2e-loop` fans recall out per space (client workaround). Server and MCP: **nobody** |
| 4 | skill | `kt_search_memories {query}` | `isError`: "search requires filters.project_ids with at least one project" | search the spaces the caller can read | nobody |
| 5 | desktop `auth.ts`, `main/auth/google.ts` | `GET /v1/auth/providers`, `POST /v1/auth/google` | `google.enabled=false`; `/auth/google` → 404 `provider_disabled` | Google sign-in shown and working | nobody. Config: needs a Google OAuth client and `OPENKT_GOOGLE_CLIENT_IDS` on `openkt-next-api` (owner) |
| 6 | Spec 04, integrations hub | `POST /v1/sessions/:id/turns {turns:[…]}` (batch) | 400 `validation_error`: the server takes one `{role, content}` per call | `{turns:[…]}` → `{appended, next_seq}`, ≤ 200 turns / 1 MB | nobody. The desktop and `feat/integrations` post one turn per call |
| 7 | `feat/integrations` hook, Spec 04 | `POST /v1/sessions` with the same `(source, external_id)` twice | 201 and 201, two sessions; `external_id` is dropped | second call → 200 with the existing session | nobody. `feat/integrations` DESIGN.md records the need |
| 8 | `feat/integrations` | `POST /v1/sessions source=codex / cursor / hermes / gemini` | 400 `validation_error` | the tools the app connects | nobody. Clients send `connector` + `client` |
| 9 | Spec 04 | `POST /v1/sessions/:id/turns` on a **closed** session | 201 (appended) | 409 | nobody. Check first whether idle-closed sessions should reopen on a new turn |
| 10 | Spec 04 | `GET /v1/sessions/:id/turns`, `POST /v1/sessions/:id/facts`, `PATCH /v1/sessions/:id`, `DELETE /v1/sessions/:id` | 404 (no route) | defined | nobody. The desktop reads turns from `GET /v1/sessions/:id` and saves facts as memories |
| 11 | desktop preview "pages", `kt_page` | `GET /v1/projects/:id/pages`, `GET /v1/pages/:id`, section edit, revisions | 404 (no route) | defined | nobody. The desktop shows pages as sample data |
| 12 | Spec 04, `kt_project_brief` | `GET /v1/projects/:id/brief` | 404 (the MCP tool works) | `{brief_md, updated_at}` | nobody |
| 13 | desktop preview "access defaults" | `GET/PUT /v1/me/connector-defaults` | 404 | defined | nobody |
| 14 | Spec 04 | `POST /v1/memories/:id/correct`, `/promote`; `POST /v1/recall/:recall_id/feedback` | 404 | defined | nobody |
| 15 | MCP cards, `kt_feedback` | recall responses | bare `Memory[]`; no `recall_id` / `reason`, REST or MCP | `{items, reason?, recall_id}` | nobody. `kt_mark_used` has no recall id to send |
| 16 | plugin skill (Spec 04 MCP table) | tools `kt_page`, `kt_feedback` | not registered (20 tools with the UI extension, 15 without) | listed | nobody |
| 17 | all MCP clients | `kt_session_start`, `kt_save_memory`, `kt_recall`, `kt_list_projects`, `kt_session_end` output | text is a raw JSON dump; no `structuredContent`; `kt_list_projects` has no `my_role`; `kt_session_start` does not lead with the brief | "a text block a model can use on its own plus `structuredContent`" | nobody. The card tools (#81) do this right |
| 18 | Spec 04 | `PATCH /v1/projects/:id {shared_with_workspace}` | 404 (no route) | defined | nobody |
| 19 | desktop "New space" | `POST /v1/projects {name}` | 400: `slug` is required | name only; the server derives the slug | nobody. Clients must send a slug |
| 20 | Spec 04 Operations | `GET /healthz`, `GET /v1/admin/jobs` | 404 | defined (`/v1/health` and `/v1/meta` work) | nobody |
| 21 | Spec 04 Auth | PAT scope names | `read` / `write` / `admin` | `context:read` / `context:write` / `admin` | nobody. Change the spec or the server |
| 22 | remote MCP connectors | OAuth discovery | works. `client_id_metadata_document_supported` absent; `/.well-known/oauth-protected-resource/mcp` (path form) 404 | "keep DCR, add Client ID Metadata Documents" | nobody. The 401's `WWW-Authenticate` points at the root document, so clients find it |

## Works on production (verified)

- **Sign-in and account (`auth.ts`):** providers; signup 201 `{token, expires_at, user}`; taken email 409 `email_taken`; login; wrong password 401 `invalid_credentials`; logout 204 (the token is dead afterwards); `POST /v1/auth/password` (the route exists; the probe was rate-limited).
- **Profile and spaces (`http.ts`):** `GET /v1/me` (`user_id`, `email`, `display_name`); `GET /v1/orgs` (0 for a new account, so the people list is just the user and sharing is by email); `GET /v1/projects/personal`; `GET /v1/projects` (a grantee sees the shared space); `GET /v1/projects/:id` with `owner_user_id`; unknown id → 404 `not_found`.
- **Sessions:** create; one turn per call; `GET /v1/sessions/:id` → `{session, turns, memories, my_role}`; list with `meta.total`; close (repeating it is fine).
- **Context:** `POST /v1/memories` with `session_id`; `DELETE /v1/memories/:id` archives; recall scoped to a project, with `owner` and `project`; secrets refused (422 `contains_secret`, and an MCP error that says why).
- **Grants on spaces and sessions:** by email (known → grant, unknown → `pending:true`); list (owner only; a reader gets 403); by user id; revoke a grant or a pending share.
- **Skills (#67):** list, create, read, a new version (per-file limit 200 KB; request bodies up to 4 MB pass nginx).
- **MCP:** `initialize` / `tools/list` / `tools/call` with a PAT bearer; card tools and `resources/list` → `ui://openkt/cards.html` when the client advertises `io.modelcontextprotocol/ui`.
- **MCP OAuth, end to end:** discovery → dynamic client registration → `/oauth/authorize` (server-rendered sign-in and consent, #73) → code → `/oauth/token` with PKCE → `tools/list` with the issued token → refresh.

## Ops (task 4)

| Check | Finding |
|---|---|
| RDS `openkt-next-postgres` backups | automated, retention 7 days, window 19:50–20:20 UTC, point-in-time restore current; encrypted; deletion protection on; single-AZ; 20 GB gp3, no storage autoscaling |
| RDS reachability | `PubliclyAccessible=false`, private IP only, SG `openkt-rds` allows 5432 only from the Dokku host SG; a connection from the internet times out. (The host's public socat port 25432 forwards to the **old** `openkt-staging-postgres`, not this one) |
| `openkt-next-api` restart policy / healthcheck | `on-failure:10` (Dokku default, restored on reboot). **Added** `.dokku/app.json`: startup check on `/v1/health`:4100 before traffic moves; seen passing on each deploy. No liveness monitor or uptime alert after startup |
| Disk (58 GB) | 30 GB used (52%). Docker build cache 9.7 GB (3.9 GB reclaimable), images 2 GB reclaimable |
| Memory (15.6 GB, 8 GB swap) | about 9.9 GB available, 17 MB swap used. New stack about 1.2 GiB (embedding 1.0 GiB, API 140 MiB); old apps about 3.5 GiB. No container has a memory limit |
| TLS | Let's Encrypt `api.openkt.ai` + `mcp.openkt.ai`, expires 2026-12-18; `@daily` renew cron in the dokku crontab |
| Deploy truthfulness | `/v1/meta` returns the commit baked into the image; the smoke test requires it. SSM output (24k limit) no longer hides build errors: full logs are in `/var/log/openkt-next-deploy/` on the host |

## Old stack: keep / retire / repoint (the owner decides)

This inventory is read-only; nothing was changed. Costs are August 2026 Cost Explorer actuals (gross; credits cover them today).

| Item | What it is today | Proposal | $/month |
|---|---|---|---|
| Dokku host `i-0b0df0fdbfc23b3d8` (m6a.xlarge + 60 GB EBS + EIP), ap-south-1 | runs the new stack **and** Ojas's 5 old apps | **keep**. Once the old apps are gone the new stack needs about 1.2 GiB, so an m6a.large would do (saves about $41) | 92 |
| Ojas's `openkt-api`, `-worker`, `-memmachine`, `-neo4j`, `-embedding` + `openkt-dev-tunnel-proxy` | last deployed 07-26; no DNS points at them; the only traffic in 7 weeks is internet scanners. The tunnel publishes the **old Postgres (25432)**, MemMachine (18080, unauthenticated), Neo4j (17474/17687) and bge-m3 (18081) to 0.0.0.0/0 | **retire** (Ojas agrees first). Close those SG ports now; rotate the keys in their config (Supabase service role, Bedrock, service tokens) | 0 direct (holds 3.5 GiB RAM, 6.6 GB disk) |
| RDS `openkt-staging-postgres` db.t4g.small, ap-south-1 | used only by the old apps | **retire** after a final snapshot | 34 |
| us-east-1 leftovers from June: 34 secrets, 4 ECR repos (14 GB), 2 KMS keys, private Route 53 zone, ECS cluster (0 tasks) + 60 task definitions, App Runner `openkt-dash` (paused), CodePipeline `openkt-main` + old CodeBuild projects, 4 alarms stuck in ALARM | nothing serves from them. A push to the old repository would still start `openkt-main` | **retire** (keep the 2 RDS final snapshots about 90 days, about $0.64) | about 17 |
| S3 `openkt-cli-prod` | `openkt.ai/install.sh` still 302-redirects here (the old CLI installer) | **keep** until a new installer replaces it | about 0 |
| `openkt.ai`, `www` → Cloudflare Pages `openkt-landing` | the new static site (`apps/site`, CodeBuild `openkt-ai-site`) | keep | 0 |
| `app.openkt.ai` → paused App Runner (404) | the old dashboard | **repoint or remove**. The new design has no web app; point it at openkt.ai or delete the record | 0 |
| `embed.openkt.ai` → deleted App Runner (NXDOMAIN) | dangling CNAME | **remove** | 0 |
| Worker `openkt-router` routes on `app.`, `embed.`, `www.`, `mcp.` | inert while those records are unproxied; would intercept MCP if `mcp` were ever proxied | **remove** the routes | 0 |
| `docs.openkt.ai` | no record | owner: create when there are docs | — |

Not OpenKT, but on the same account: Hermes in ap-southeast-2 ($164 in August) and two 200 GB gastown snapshots ($20).
