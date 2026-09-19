# Deploying the hosted server

The hosted OpenKT server runs on a Dokku host in AWS. **CI runs on AWS CodeBuild, not GitHub Actions** (Actions is disabled for this repository; GitHub only hosts the code). CodeBuild project `openkt-ai-deploy` (us-east-1) deploys on every push to `main` that touches `server/`, `docker/`, `.dokku/`, `deploy/dokku/`, `scripts/deploy-from-box.sh` or `.codebuild/deploy.yml`. It runs `scripts/deploy-from-box.sh <pushed commit>` (buildspec `.codebuild/deploy.yml`). A person runs the same script by hand when needed. The deployment path and host layout follow the design Ojas Sinha built for the original backend.

| CodeBuild project | Trigger | Buildspec | Service role (least privilege) |
|---|---|---|---|
| `openkt-ai-deploy` | push to `main`, paths above | `.codebuild/deploy.yml` | `codebuild-openkt-ai-deploy`: its log group, `ci/*` in the artifact bucket, `ssm:SendCommand` to the one instance + `AWS-RunShellScript`, read command results, the GitHub connection |
| `openkt-ai-pr-checks` | pull request opened / updated / reopened; from a fork only after a maintainer approves | `.codebuild/pr-checks.yml` | `codebuild-openkt-ai-pr-checks`: its log group and the GitHub connection, nothing else |
| `openkt-ai-site` | push to `main` touching `apps/site/` or `.codebuild/site.yml` | `.codebuild/site.yml`: `wrangler pages deploy` to Cloudflare Pages `openkt-landing`, then checks openkt.ai serves `apps/site/index.html` | `codebuild-openkt-ai-site`: its log group, the GitHub connection, SSM parameter `/openkt-ai/cloudflare-pages-token` |

All three check out the code through the CodeConnections GitHub connection `openkt-github` (us-east-1) and report a commit status on GitHub (`openkt-ai-deploy`, `openkt-ai-pr-checks`, `openkt-ai-site`). Logs: CloudWatch `/aws/codebuild/<project>`; the console lists every build. `scripts/deploy-from-box.sh` never deploys backwards: when production already runs the commit or a newer one it stops (`FORCE_DEPLOY=1` overrides). Desktop builds need a macOS machine and are not connected yet; see `docs/ci/README.md`.

## Why it is built this way

| Choice | Reason |
|---|---|
| One Dokku app per component, each a Dockerfile build from the same source archive | Components deploy and roll back independently; heavy images (embeddings) rebuild only when their Dockerfile changes. |
| A private Docker network; internal apps set `NO_VHOST` and are reached as `<app>.web` | Only the API is reachable from the internet. |
| Migrations run in the Dokku **release** phase (`.dokku/Procfile.api`) | A failed migration stops the deploy before the new web process takes traffic. |
| State lives off the host (managed Postgres) | The host is disposable; rebuilding it loses nothing. |
| CodeBuild role → source archive in S3 → Systems Manager → `dokku git:from-archive` | No SSH port and no AWS keys anywhere. The role can only write `ci/*` artifacts and send the AWS-managed shell document to the one instance; the archive is deleted after the deploy. |
| Deployments are serialized (one build at a time, plus a lock on the host) and never go backwards | A newer push waits rather than interrupting a half-finished release; a late older build is skipped. |

## Apps

| App | Image | Exposure |
|---|---|---|
| `openkt-next-api` | `docker/Dockerfile.api` — the NestJS API and MCP endpoint, port 4100 | public: `api.openkt.ai`, `mcp.openkt.ai`, TLS by Let's Encrypt |
| `openkt-next-embedding` | `docker/Dockerfile.embedding` — llama.cpp serving Qwen3-Embedding-0.6B | private network only |

There is no worker app yet: facts are embedded when saved (`OPENKT_INLINE_EMBED`). It returns with the Postgres job queue.

## Settings

`scripts/deploy-from-box.sh` needs four values. CodeBuild sets them in the project environment. On a workstation, export them, or let the script read them with `gh` from the GitHub environment `production` (a plain settings store now that Actions is off):

| Variable | Value |
|---|---|
| `AWS_REGION` | `ap-south-1`: region of the instance, the SSM endpoint and the artifact bucket |
| `DOKKU_INSTANCE_ID` | the SSM-managed Dokku instance |
| `DEPLOY_ARTIFACT_BUCKET` | temporary source-archive bucket (`ci/<sha>/…`, deleted after each deploy) |
| `PUBLIC_URL` | where the smoke test looks: `https://api.openkt.ai` |

The old GitHub OIDC role `openkt-next-github-dokku-deploy` still trusts `repo:masti-ai@267711818/OpenKT-ai@1376876585:environment:production`. Nothing uses it while Actions is disabled.

## Deploying by hand, and proving what runs

`GET /v1/meta` (public) answers `{version, commit, built_at, …}`. The commit comes from `build-info.json`, which `deploy/dokku/ship.sh` writes into the source archive, so it is baked into the image and cannot drift from the running code. The post-deploy smoke test (`deploy/dokku/smoke.sh`) passes only when `/v1/meta` reports the commit just shipped and `/v1/projects` still refuses a tokenless call with 401.

By hand: `scripts/deploy-from-box.sh [git-ref]` (default: exactly `origin/main`). It runs the same `ship.sh` and `smoke.sh` as CodeBuild, refuses a dirty tree, and takes a local lock; the host takes its own lock, so two deploys never overlap. Full build logs stay on the host in `/var/log/openkt-next-deploy/` (SSM only returns the last 24 000 characters); the deploy prints their tail.

Each release runs its migrations (release phase), then Dokku waits for the `.dokku/app.json` startup healthcheck (`/v1/health` on port 4100) before it moves traffic; a failed check leaves the previous release serving.

## First-time host setup

`deploy/dokku/bootstrap.sh` (run once as root on the host, for example through Systems Manager) creates the two apps with their builder paths, network, port map, configuration and domains. It is idempotent. After the first successful deploy, request the certificate (until it exists nothing listens on 443 and the smoke test fails with status 000 — that is what failed the very first deploy):

```
dokku letsencrypt:enable openkt-next-api && dokku letsencrypt:cron-job --add
```

## Configuration that is not in the repository

Secrets live only in the Dokku app config on the host (`dokku config:show openkt-next-api`): the database URL, the two service tokens, and — to turn on Google sign-in — `OPENKT_GOOGLE_CLIENT_IDS`.
