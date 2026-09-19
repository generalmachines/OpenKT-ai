# OpenKT Server API Endpoint Map

Generated from the NestJS Swagger contract on 2026-05-09.

Canonical OpenAPI JSON:

- `api/docs/openapi/server.v1.json`

Frontend, CLI, and MCP clients should integrate against these `/v1/*` routes.
Do not add dashboard-only Next.js API routes unless they are thin proxies or
frontend-owned assets.

## Auth

- `POST /v1/auth/password`
- `POST /v1/auth/signup`
- `POST /v1/auth/magic-link`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `POST /v1/auth/device-code`
- `GET /v1/auth/device-code/{code}/status`
- `POST /v1/auth/device-confirm`
- `GET /v1/internal/auth/me`
- `GET /v1/internal/auth/service`

## Profile

- `GET /v1/me`
- `PATCH /v1/me`

## Orgs And Projects

- `GET /v1/orgs`
- `POST /v1/orgs`
- `GET /v1/orgs/slug/{slug}`
- `GET /v1/orgs/slug/{slug}/members`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/{id}`
- `GET /v1/projects/slug/{account_slug}/{project_slug}`

## Memory

- `GET /v1/memories`
- `POST /v1/memories`
- `GET /v1/memories/{id}`
- `DELETE /v1/memories/{id}`
- `GET /v1/memories/{id}/access`
- `POST /v1/memories/search`
- `POST /v1/memories/recall`
- `POST /v1/memories/answer`
- `POST /v1/memories/enhance`

Notes:

- `POST /v1/memories/enhance` is a composer helper, not the canonical memory
  write path.
- There is intentionally no `backfill-tags` endpoint. That was legacy dashboard
  repair UI and should be removed from the frontend.

## Intelligence Outputs

- `GET /v1/briefings`
- `POST /v1/briefings`
- `GET /v1/projects/{project_id}/members`
- `GET /v1/projects/{project_id}/members/mix?user_ids=a,b,c`
- `GET /v1/projects/{project_id}/members/{user_id}/knowledge`
- `POST /v1/prime`

## Provider Config And Settings

- `GET /v1/llm-configs`
- `POST /v1/llm-configs`
- `PATCH /v1/llm-configs/{id}/enabled`
- `POST /v1/llm-configs/{id}/test`
- `GET /v1/secrets/orgs/{orgSlug}`
- `GET /v1/settings/user`
- `PUT /v1/settings/user`
- `GET /v1/settings/orgs/{orgSlug}`
- `PUT /v1/settings/orgs/{orgSlug}`
- `GET /v1/settings/projects/{projectId}`
- `PUT /v1/settings/projects/{projectId}`

## Observability

- `GET /v1/observability/summary`
- `GET /v1/observability/tools`
- `GET /v1/observability/tools/{name}`
- `GET /v1/observability/invocations`
- `GET /v1/observability/invocations/{id}`
- `GET /v1/observability/memories/{id}/activity`

Notes:

- Observability is for OpenKT tool/memory/pipeline activity.
- There are no workflow observability endpoints in V1.

## Internal Ops

- `GET /v1/internal/health/live`
- `GET /v1/internal/health/ready`
- `GET /v1/internal/observability/pipeline`
- `GET /v1/internal/observability/memories/{id}/timeline`

Internal routes are not frontend contracts.

## Deprecated Frontend Routes To Remove

The old `openkt` Next app still has local API routes that should not remain as
business logic after frontend consolidation:

- `/api/memories/backfill-tags`
- `/api/observability/workflows`
- Legacy local memory service routes that duplicate `/v1/memories/*`
- Legacy local auth routes replaced by Supabase SDK or `/v1/auth/*`
- Legacy backend/worker/infra code copied into the frontend repo
