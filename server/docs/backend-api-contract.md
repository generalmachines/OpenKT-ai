# OpenKT Backend API Contract

Date: 2026-05-09

This is the handoff contract for CLI, MCP, and frontend agents. The product-facing backend is OpenKT. Internal implementation details, including memory storage strategy, must stay behind this API.

## Base Contract

- Local API base: `http://127.0.0.1:4102/v1` in the current dev stack, or `http://127.0.0.1:4100/v1` when the default port is free.
- Swagger UI: `/v1/docs`
- Swagger JSON: `/v1/docs-json`
- Authenticated routes use `Authorization: Bearer <supabase_access_token>`.
- Success envelope:

```json
{
  "data": {},
  "error": null,
  "meta": {}
}
```

Paged success envelope:

```json
{
  "data": [],
  "error": null,
  "meta": {
    "total": 0,
    "limit": 50,
    "offset": 0,
    "has_more": false
  }
}
```

## Product Boundary

OpenKT owns the user-facing product contract:

- Auth and tenancy.
- OpenKT CLI commands.
- OpenKT MCP tools.
- Memory ingest, recall, search, forget.
- RabbitMQ worker pipeline.
- LLM gateway / model selection / user provider keys.
- Briefings, member-knowledge rollups, session prime, insights.

Memory implementation can change underneath this boundary. CLI and frontend should never call a third-party memory engine directly.

## Memory System Decision

MemMachine is now integrated as the default V1 memory substrate behind the
OpenKT-owned `MemoryEngine` interface. It is internal infrastructure, not a
public product API.

OpenKT still owns:

- Auth, tenancy, projects, orgs, and memberships.
- Canonical memory metadata and audit state.
- Mapping MemMachine ids through `memory_external_refs`.
- CLI/MCP/frontend contracts.
- RabbitMQ synthesis pipeline.
- Briefings, member-knowledge rollups, prime, context packs, and future dashboard insights.

MemMachine owns lower-level memory store/search/recall behavior. If MemMachine
becomes a liability later, OpenKT can swap the adapter without changing CLI,
MCP, or frontend contracts.

## Auth

### `POST /v1/auth/password`

Email/password login.

Request:

```json
{
  "email": "user@example.com",
  "password": "password"
}
```

Use returned token as `Authorization: Bearer <token>`.

### `POST /v1/auth/signup`

Email/password signup. Currently blocked locally if Supabase Auth DB provisioning returns `Database error saving new user`.

### `POST /v1/auth/refresh`

Request:

```json
{
  "refresh_token": "..."
}
```

### Device Code Flow

For CLI browser login:

- `POST /v1/auth/device-code`
- `GET /v1/auth/device-code/:code/status`
- `POST /v1/auth/device-confirm` with bearer auth

The CLI should start the code, show the dashboard URL/code, then poll status until approved/expired.

## Projects

### `GET /v1/projects`

Lists projects visible to the user.

Optional query:

- `org_id`
- `visibility`: `personal | org | public`

### `POST /v1/projects`

Request:

```json
{
  "slug": "my-project",
  "name": "My Project",
  "visibility": "personal",
  "org_id": null
}
```

### `GET /v1/projects/:id`

Get by UUID.

### `GET /v1/projects/slug/:account_slug/:project_slug`

Get by slug pair.

## Memories

### `POST /v1/memories`

Create a memory and enqueue the async RabbitMQ pipeline through the outbox.

Request:

```json
{
  "content": "Decision: use BGE-M3 embeddings through the OpenKT worker pipeline.",
  "kind": "decision",
  "project_id": "project-uuid-or-slug",
  "visibility": "project",
  "tag_slugs": ["backend", "memory"],
  "category": "architecture",
  "confidence": 1,
  "importance": 0.7,
  "source_refs": [
    { "kind": "url", "ref": "https://example.com/context" }
  ]
}
```

Important behavior:

- The API writes `memories`.
- The API writes the memory to MemMachine through `MemoryEngine.remember`.
- The API stores the provider id in `memory_external_refs`.
- It writes an `outbox_events` row.
- The outbox relay publishes to RabbitMQ.
- Worker stages process the memory asynchronously.

### `GET /v1/memories?project_id=<uuid>`

List memories in a project.

Useful query params:

- `limit`
- `offset`
- `include_archived`
- `q`
- `kind`
- `visibility`
- `min_confidence`
- `tag`

### `GET /v1/memories/:id`

Fetch one memory.

### `DELETE /v1/memories/:id`

Soft-forget by default. Use `?hard=true` only for destructive deletion.

### `POST /v1/memories/search`

Search memory rows. This is read-only and should not bump recall counters.

Request:

```json
{
  "query": "What did we decide about embeddings?",
  "mode": "hybrid",
  "vector_weight": 0.6,
  "workspace_weight": 0.4,
  "filters": {
    "project_ids": ["project-uuid"],
    "include_archived": false,
    "include_superseded": false
  },
  "limit": 20
}
```

With `OPENKT_MEMORY_ENGINE=memmachine`, this routes through MemMachine and maps
hits back to OpenKT memory rows.

### `POST /v1/memories/recall`

Recall is the CLI/MCP/session-prime retrieval path. It should log recall access and return ranked memory rows.

Request:

```json
{
  "project_id": "project-uuid-or-slug",
  "query": "What should I know before working on the backend?",
  "limit": 10,
  "vector_weight": 0.6,
  "workspace_weight": 0.4,
  "min_confidence": 0
}
```

With `OPENKT_MEMORY_ENGINE=memmachine`, recall uses the same adapter search path
and records recall telemetry in OpenKT.

### `POST /v1/memories/answer`

Composes an answer from recalled memories.

Request:

```json
{
  "project_id": "project-uuid-or-slug",
  "question": "What is the backend memory pipeline?",
  "limit": 15,
  "vector_weight": 0.6
}
```

## OpenKT MCP

Endpoint:

```text
/v1/mcp
```

Transport:

- Streamable HTTP JSON-RPC.
- Bearer auth required.
- Server name: `openkt`.

Tools:

- `memory_remember`
- `memory_recall`
- `memory_search`
- `memory_forget`

The CLI and external clients should use OpenKT MCP only. Do not expose internal memory engines directly.

## Prime

### `POST /v1/prime`

Builds the session-start context payload.

Request:

```json
{
  "project_id": "project-uuid-or-slug",
  "with_briefing": true
}
```

Used by CLI/MCP agents when starting a work session.

## Briefings

### `GET /v1/briefings?project_id=<uuid>`

Fetch current team briefing.

### `POST /v1/briefings`

Regenerate briefing.

Request:

```json
{
  "project_id": "project-uuid"
}
```

Briefings are OpenKT intelligence-layer output. They should remain ours even if the underlying retrieval implementation changes later.

## Member Knowledge

Per-contributor knowledge rollups. Replaces the legacy `pulse` endpoints
(table `team_pulse_events` was renamed `member_knowledge` in migration
0016 and reshaped from an event-stream into a per-(project, user)
aggregate of LLM-synthesised `summary` + `themes`).

### `GET /v1/projects/:project_id/members`

List contributors with summary stats.

Response:

```json
{
  "data": [
    {
      "user_id": "user-uuid",
      "display_name": "Maya",
      "avatar_url": null,
      "memory_count": 17,
      "episode_count": 0,
      "themes": [{ "tag": "auth", "weight": 0.42, "memory_count": 7 }],
      "summary": "Drove the auth + RBAC redesign across H1 2026...",
      "last_contribution_at": "2026-05-11T08:14:02Z"
    }
  ],
  "meta": { "project_id": "...", "total": 1 }
}
```

### `GET /v1/projects/:project_id/members/:user_id/knowledge`

Single-member detail. Response includes `summary`, `themes`,
`stats { memory_count, episode_count, first_contribution_at,
last_contribution_at, tags_owned }`, and `recent_memories[]`.

### `GET /v1/projects/:project_id/members/mix?user_ids=a,b,c`

List memories scoped to a subset of contributors (used by the "show
me what these two people built" view).

## LLM Configs

### `GET /v1/llm-configs?scope_type=user&scope_id=<uuid>`

List masked provider configs.

### `POST /v1/llm-configs`

Create or rotate encrypted provider config.

Request:

```json
{
  "scope_type": "user",
  "scope_id": "user-uuid",
  "provider": "minimax",
  "label": "default",
  "base_url": "https://api.minimax.villamarket.ai/v1",
  "model": "MiniMax-M2.5",
  "api_key": "secret",
  "enabled": true
}
```

### `PATCH /v1/llm-configs/:id/enabled`

Request:

```json
{ "enabled": false }
```

### `POST /v1/llm-configs/:id/test`

Validates saved provider config with a tiny prompt.

## RabbitMQ Memory Pipeline

When `POST /v1/memories` succeeds, processing is asynchronous:

1. API writes the memory row.
2. API writes `outbox_events` with `memory.created`.
3. Outbox relay publishes `memory.preprocess`.
4. Worker runs preprocess.
5. Worker runs embed and writes BGE-M3 vector to `memories.embedding`.
6. Worker runs triage for duplicate/supersede/tag behavior.
7. Worker runs episode clustering.
8. Worker triggers/updates briefing generation.

This is where most OpenKT business logic should live. The memory store is infrastructure; the intelligence layer is the product.

## Backend Tasks Before CLI/Frontend Freeze

- Verify OpenKT MCP `tools/list` and all four memory tools against a valid JWT.
- Verify CLI `login`, `init`, `remember`, `recall/search`, and `forget` using only OpenKT endpoints.
- Verify `POST /v1/prime` after recall is complete.
- Run multi-project and multi-user isolation tests.
- Run RabbitMQ restart recovery test.
- Run MemMachine restart recovery test.
- Keep MiniMax default at the working model for the current key: `MiniMax-M2.5`.
