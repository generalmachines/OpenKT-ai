# Deploying the hosted server

The hosted OpenKT server runs on a Dokku host in AWS and is deployed by `.github/workflows/deploy-dokku.yml` on every push to `main` that touches `server/`, `docker/` or `.dokku/`. The deployment path and host layout follow the design Ojas Sinha built for the original backend; this repository reuses it unchanged in shape.

## Why it is built this way

| Choice | Reason |
|---|---|
| One Dokku app per component, each a Dockerfile build from the same source archive | Components deploy and roll back independently; heavy images (embeddings) rebuild only when their Dockerfile changes. |
| A private Docker network; internal apps set `NO_VHOST` and are reached as `<app>.web` | Only the API is reachable from the internet. |
| Migrations run in the Dokku **release** phase (`.dokku/Procfile.api`) | A failed migration stops the deploy before the new web process takes traffic. |
| State lives off the host (managed Postgres) | The host is disposable; rebuilding it loses nothing. |
| GitHub OIDC → short-lived role → source archive in S3 → Systems Manager → `dokku git:from-archive` | No SSH port, no long-lived AWS keys in GitHub. The role can only write `ci/*` artifacts and send the AWS-managed shell document to the one instance; the archive is deleted after the deploy. |
| Deployments are serialized (`concurrency`, no cancel-in-progress) | A newer push waits rather than interrupting a half-finished release. |
| Actions pinned by commit SHA | A compromised tag cannot change what runs with deploy rights. |

## Apps

| App | Image | Exposure |
|---|---|---|
| `openkt-next-api` | `docker/Dockerfile.api` — the NestJS API and MCP endpoint, port 4100 | public: `api.openkt.ai`, `mcp.openkt.ai`, TLS by Let's Encrypt |
| `openkt-next-embedding` | `docker/Dockerfile.embedding` — llama.cpp serving Qwen3-Embedding-0.6B | private network only |

There is no worker app yet: facts are embedded when saved (`OPENKT_INLINE_EMBED`). It returns with the Postgres job queue.

## GitHub environment `production` (restricted to `main`)

| Variable | Purpose |
|---|---|
| `AWS_REGION` | Region of the instance and the SSM endpoint |
| `AWS_ROLE_ARN` | The OIDC deploy role, trusted only for the immutable subject `repo:masti-ai@267711818/OpenKT-ai@1376876585:environment:production` (the repository id stays when the repository is renamed; the old name `openkt-next` stays in the trust policy until a deploy under the new name has passed) |
| `DOKKU_INSTANCE_ID` | The SSM-managed Dokku instance |
| `DEPLOY_ARTIFACT_BUCKET` | Temporary source-archive bucket |
| `PUBLIC_URL` | Where the post-deploy smoke test looks, e.g. `https://api.openkt.ai` |

## Deploying by hand, and proving what runs

`GET /v1/meta` (public) answers `{version, commit, built_at, …}`. The commit comes from `build-info.json`, which `deploy/dokku/ship.sh` writes into the source archive, so it is baked into the image and cannot drift from the running code. The post-deploy smoke test (`deploy/dokku/smoke.sh`) passes only when `/v1/meta` reports the commit just shipped and `/v1/projects` still refuses a tokenless call with 401.

When GitHub Actions cannot run, deploy from a workstation with `scripts/deploy-from-box.sh [git-ref]` (default: exactly `origin/main`). It runs the same `ship.sh` and `smoke.sh` as the workflow, refuses a dirty tree, and takes a local lock; the host takes its own lock, so two deploys never overlap. Full build logs stay on the host in `/var/log/openkt-next-deploy/` (SSM only returns the last 24 000 characters); the deploy prints their tail.

Each release runs its migrations (release phase), then Dokku waits for the `.dokku/app.json` startup healthcheck (`/v1/health` on port 4100) before it moves traffic; a failed check leaves the previous release serving.

## First-time host setup

`deploy/dokku/bootstrap.sh` (run once as root on the host, for example through Systems Manager) creates the two apps with their builder paths, network, port map, configuration and domains. It is idempotent. After the first successful deploy, request the certificate (until it exists nothing listens on 443 and the smoke test fails with status 000 — that is what failed the very first deploy):

```
dokku letsencrypt:enable openkt-next-api && dokku letsencrypt:cron-job --add
```

## Configuration that is not in the repository

Secrets live only in the Dokku app config on the host (`dokku config:show openkt-next-api`): the database URL, the two service tokens, and — to turn on Google sign-in — `OPENKT_GOOGLE_CLIENT_IDS`.
