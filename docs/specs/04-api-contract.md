# Spec 04 — API and MCP contract

> Owner: maintainers. Status: decided for v0.1–v0.2. The server (`apps/server`), the desktop app's `http` adapter, the plugin and the MCP cards all code against this file. Change it here first, in its own pull request.

Conventions: JSON everywhere; `Authorization: Bearer <jwt | okt_pat_…>`; ids are UUIDs; times are ISO-8601 UTC; errors are `{ "error": { "code": "snake_case", "message": "…" } }` with 400/401/403/404/409/422/429. **A resource the caller cannot read returns 404, not 403** — existence is not leaked. Lists take `?limit=` (default 50, max 200) and `?cursor=`, and return `{ items, next_cursor }`.

The database says `project` and `memory`; the API keeps those words in paths for backward compatibility. User-facing text says **space** and **context**.

## REST

### Sessions
| Method + path | Body → Response |
|---|---|
| `POST /v1/sessions` | `{project_id?, source, client?, title?, external_id?, external_url?, metadata?}` → `201 Session`. No `project_id` → the caller's personal space. Same `(source, external_id)` → `200` with the existing session. |
| `POST /v1/sessions/:id/turns` | `{turns:[{role, speaker?, content, t0_ms?, t1_ms?}]}` → `{appended, next_seq}`. Max 200 turns or 1 MB per call. Closed session → 409. |
| `POST /v1/sessions/:id/facts` | `{facts:[{statement, quote, kind, tags?}], extractor:{agent_version, model}}` → `{accepted, dropped:[{index, reason}]}`. For clients that extract locally; the server re-runs the quote gate. |
| `POST /v1/sessions/:id/close` | `{summary?, title?}` → `Session`. Enqueues the write pipeline. Idempotent. |
| `GET /v1/sessions` | `?project_id=&source=&status=&q=` → list of `Session` (no turns), newest first, only sessions the caller may read. |
| `GET /v1/sessions/:id` | → `Session` + `facts[]` + `attachments[]` + `my_role`. |
| `GET /v1/sessions/:id/turns` | → turns. **Requires `editor` or `owner`** — readers get facts, not transcripts. |
| `PATCH /v1/sessions/:id` | `{title?, project_id?}` (owner). Moving a session re-scopes its facts. |
| `DELETE /v1/sessions/:id` | owner. Archives its facts; pages re-render without them at the next lint. |

`Session = {id, project_id, owner:{id,name}, source, client, title, summary, status, started_at, ended_at, fact_count, my_role}`

### Context (facts)
| | |
|---|---|
| `POST /v1/memories` | existing; now also accepts `session_id`. |
| `POST /v1/memories/recall` | `{query, project_id?, session_id?, k?}` → `{items:[RecallItem], reason?, recall_id}` per Spec 01 §4. |
| `POST /v1/memories/:id/promote` | `{project_id}` → the new fact. |
| `POST /v1/memories/:id/correct` | `{statement}` (editor) → a new fact superseding the old one, confidence 0.90. |
| `POST /v1/recall/:recall_id/feedback` | `{used:[ids], unused?:[ids]}` → 204. |

`RecallItem = {id, type:'fact'|'section', text, kind?, tags?, space:{id,name}, author:{id,name}, session?:{id,title,source}, page?:{id,title}, created_at, score}`

### Spaces, pages, briefs
| | |
|---|---|
| `GET /v1/projects` · `POST /v1/projects` · `PATCH /v1/projects/:id` | existing; PATCH gains `shared_with_workspace`. |
| `GET /v1/projects/:id/pages` | → `[{id, slug, title, summary, version, updated_at, session_count}]` |
| `GET /v1/pages/:id` | → `{…page, sections:[{id, heading, body_md, locked}], sources:[{n, session}], reach:{sessions_7d, people_7d}}` |
| `PUT /v1/pages/:id/sections/:sid` | `{body_md, heading?}` (editor) → sets `locked=true`, writes a revision. |
| `GET /v1/pages/:id/revisions` · `POST /v1/pages/:id/revisions/:v/restore` | |
| `GET /v1/projects/:id/brief` | → `{brief_md, updated_at}` |

### Access
| | |
|---|---|
| `GET /v1/projects/:id/grants` · `GET /v1/sessions/:id/grants` | owner/editor → `[{id, subject:{id,name,email}, role, inherited_from?}]` |
| `PUT /v1/projects/:id/grants` · `PUT /v1/sessions/:id/grants` | `{subject_id \| email, role}` (owner). An unknown email creates an invite. Upsert. |
| `DELETE /v1/grants/:grant_id` | owner. The last owner cannot be removed → 409. |
| `GET /v1/me/connector-defaults` · `PUT /v1/me/connector-defaults/:source` | `{project_id?, grant_template:[{subject_id, role}]}` |

### Operations
`GET /healthz` · `GET /v1/meta` → `{version, embedding_model, rerank:boolean, features:[]}` · `GET /v1/admin/jobs?status=` (workspace owner).

## MCP tools (`POST /mcp`, Streamable HTTP)

Every tool has `title` and `annotations` (`readOnlyHint` / `destructiveHint`). Every tool returns a **text block a model can use on its own** plus `structuredContent`. Descriptions ≤ 2 KB. Parameter is `project` (slug or id) for compatibility; the text shown to users says "space".

| Tool | Input | Returns |
|---|---|---|
| `kt_session_start` | `{project?, title?, client?}` | `{session_id, space, brief_md}` — text = the brief, then: "Your session id is … Pass it to kt_recall / kt_save_memory / kt_session_end." |
| `kt_recall` | `{query, project?, session_id?, k?}` | RecallItems as a numbered list with `— author, source, date`; `recall_id`. Empty → "Nothing relevant in the spaces you can read." |
| `kt_save_memory` | `{content, kind?, project?, session_id?, visibility?}` | `{id, space, visibility}`. With no `project` and no session → personal space. Refuses secrets (Spec 02 §9). |
| `kt_session_end` | `{session_id, summary}` | `{fact_count}` |
| `kt_list_projects` | `{}` | spaces the caller can write to first, then read-only ones, each with `my_role`. |
| `kt_project_brief` | `{project}` | `brief_md` |
| `kt_page` | `{page_id \| project + title}` | the page as markdown with sources |
| `kt_feedback` | `{recall_id, used:[ids]}` | ok |
| `kt_search_memories` · `kt_forget_memory` | existing | unchanged |
| `kt_setup` | `{client?}` | paste-able setup steps for that client. **No mock tokens.** |

Card tools (registered only when the client advertises the `io.modelcontextprotocol/ui` extension; resource `ui://openkt/cards.html`, MIME `text/html;profile=mcp-app`):

| Tool | Visible to | Purpose |
|---|---|---|
| `kt_save_card` | model | `{content, kind?, suggested_project?}` → opens the save card. `structuredContent = {view:'save', statement, kind, page_hint?, spaces:[{id,name,access_label,writable:true}], default_space_id}` |
| `kt_search_card` | model | `{query, project?}` → `{view:'search', query, space_label, items:[RecallItem], recall_id}` |
| `kt_session_card` | model | `{session_id}` → `{view:'session', title, summary, facts:[…], space, access_label}` |
| `kt_commit_save` | **app only** (`visibility:["app"]`) | `{statement, kind, project_id \| 'personal'}` → performs the save |
| `kt_mark_used` | **app only** | `{recall_id, id}` → feedback |

Clients without the extension never see the card tools; `kt_save_memory` and `kt_recall` are the fallback. Where form elicitation is supported, `kt_save_memory` called with no `project` and more than one writable space elicits the space; elsewhere it saves to the personal space and says so.

### Server `instructions` (≤ 2 KB) — the behavioural contract

```
OpenKT is this team's shared context. Use it so people do not have to re-explain things.
1. At the start of work call kt_session_start (pass the space if the user names a project, customer or team). Keep the session_id.
2. Before non-trivial work, and whenever the user mentions a decision, person, customer, system or "like last time", call kt_recall. Cite what you use by author.
3. When something durable is settled — a decision, a fact, a how-to, an issue and its cause, an open question, an owner and deadline, an idea — call kt_save_memory right then, one short self-contained statement each. Never save secrets, credentials or private personal data.
4. If it is unclear which space something belongs to, ask once; otherwise use the session's space. Personal is the default.
5. When the work ends, call kt_session_end with a 2–3 sentence summary.
If a tool fails, continue the user's task and mention it once.
```

## Auth

- Built-in sign-in: email magic link + OIDC (Google, GitHub), issuing the server's own JWT. Supabase JWTs stay accepted while `OPENKT_SUPABASE_JWKS_URL` is set.
- OAuth 2.1 + PKCE for MCP clients: keep Dynamic Client Registration, add Client ID Metadata Documents.
- PAT scopes are enforced: `context:read`, `context:write`, `admin`. A read-only token calling a write tool → 403 `insufficient_scope`.

## Configuration (environment)

`DATABASE_URL` · `OPENKT_LLM_BASE_URL` `OPENKT_LLM_API_KEY?` `OPENKT_LLM_MODEL=qwen3.5-4b` · `OPENKT_EMBED_URL` `OPENKT_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B` · `OPENKT_RERANK_URL?` · `OPENKT_PUBLIC_URL` · `OPENKT_BLOB_DIR | OPENKT_S3_*` · `OPENKT_ALLOW_REINDEX?` · `OPENKT_QUEUE_BACKEND=postgres|sqs|rabbitmq` (default `postgres`).
