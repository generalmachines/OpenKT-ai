# Phase 5 Frontend Integration Guide

This guide is the handoff surface for frontend work against the SGS
NestJS backend in `api/`.

## Canonical contract

- Swagger UI: `/v1/docs`
- OpenAPI JSON: `/v1/docs-json`
- Checked-in OpenAPI JSON: `docs/openapi/server.v1.json`
- API base prefix: `/v1`

The OpenAPI document is generated from the Nest controllers. Frontend
work should use that document as the source of truth for paths,
request shapes, and auth requirements.

To regenerate the checked-in contract:

```bash
npm run openapi:generate
```

## Auth

Most frontend-facing routes require:

```http
Authorization: Bearer <supabase-access-token>
```

Swagger marks these routes with the `supabase-bearer` scheme.

## Response envelope

Successful SGS responses use one of these envelopes:

```json
{
  "data": {},
  "error": null,
  "meta": null
}
```

```json
{
  "data": [],
  "error": null,
  "meta": {}
}
```

The frontend should treat `error !== null` as the failure path and
read `data` from the success path.

## Route groups for frontend

- `POST /v1/prime`
  - session-start composition
  - returns `project`, `memories`, `reconciliation`, and `briefing`
- `GET/POST /v1/memories`
  - list and create memories
- `POST /v1/memories/search`
  - search API
- `POST /v1/memories/recall`
  - retrieval API
- `POST /v1/memories/answer`
  - synchronous cross-memory answer composition
- `GET /v1/memories/:id`
  - memory detail
- `GET /v1/memories/:id/access`
  - access summary
- `GET/POST /v1/projects`
  - list and create projects
- `GET /v1/projects/:id`
  - project detail
- `GET /v1/projects/slug/:accountSlug/:projectSlug`
  - slug lookup
- `GET/PATCH /v1/profile/me`
  - current user profile
- `GET/PUT /v1/settings/user`
  - user settings
- `GET/PUT /v1/settings/projects/:projectId`
  - project settings
- `GET/PUT /v1/settings/orgs/:orgSlug`
  - org settings
- `GET/POST /v1/orgs`
  - org list and create
- `GET /v1/orgs/slug/:slug`
  - org detail
- `GET /v1/orgs/slug/:slug/members`
  - org members
- `POST /v1/invites/accept`
  - invite acceptance
- `GET /v1/secrets/orgs/:orgSlug`
  - secret metadata only

## Current Phase 5 boundary

- Use SGS as the canonical backend for frontend reads/writes covered by
  the routes above.
- Do not depend on legacy Next `/api/*` routes for the same domain
  surface if an SGS route already exists.
- Async memory-engine stages now run in the SGS worker through the
  RabbitMQ pipeline. Frontend should still treat memory creation as
  synchronous durable write plus eventual enrichment, not as “all
  derivations completed before the response returns.”

## Recommended frontend workflow

1. Start `openkt` locally.
2. Open `/v1/docs` and inspect the operations you plan to call.
3. Generate or consume the `/v1/docs-json` contract in the frontend
   workspace.
4. Build typed client helpers around the envelope shape above.
5. Keep frontend route contracts aligned with Swagger, not ad-hoc
   request snippets in chat.
