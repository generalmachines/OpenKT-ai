#!/usr/bin/env bash
# Deploy the hosted server (api.openkt.ai / mcp.openkt.ai) from a workstation, through the SAME path as
# .github/workflows/deploy-dokku.yml — both call deploy/dokku/ship.sh (git archive → S3 ci/<sha> → SSM →
# dokku git:from-archive → release-phase migrations → healthcheck) and deploy/dokku/smoke.sh. Use it when
# GitHub Actions cannot run; otherwise merging to main deploys by itself.
#
#   scripts/deploy-from-box.sh              deploy exactly origin/main (fetched first)
#   scripts/deploy-from-box.sh <git-ref>    deploy that ref instead (a sha, a tag, origin/<branch>)
#   DEPLOY_EMBEDDING=true scripts/…         also rebuild openkt-next-embedding (default: only when
#                                           docker/Dockerfile.embedding changed since the running commit)
#
# Needs: git ≥ 2.39, jq, curl, flock, the AWS CLI with credentials that may write the artifact bucket and send
# SSM commands to the Dokku host, and either `gh` signed in to the repository (the settings are read from its
# GitHub environment `production`) or AWS_REGION, DOKKU_INSTANCE_ID, DEPLOY_ARTIFACT_BUCKET, PUBLIC_URL set.
# Refuses a dirty working tree. One deploy at a time: /tmp/openkt-deploy.lock here, plus a host-wide lock that
# also covers deploys from GitHub.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

exec 8>/tmp/openkt-deploy.lock
if ! flock -n 8; then
  echo "Another deploy from this machine is running; waiting for it (up to 30 minutes)…"
  flock -w 1800 8 || { echo "Gave up waiting for /tmp/openkt-deploy.lock"; exit 1; }
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to deploy from a dirty working tree:"; git status --short; exit 1
fi

setting() { # name → value from the environment, else from the GitHub environment `production`
  local v="${!1:-}"
  # `gh variable list --json` works on old gh releases too (`gh variable get` needs gh ≥ 2.47).
  [ -n "${v}" ] || v="$(gh variable list --env production --json name,value \
    --jq ".[] | select(.name == \"$1\") | .value" 2>/dev/null || true)"
  [ -n "${v}" ] || { echo "Missing setting $1 (export it, or sign in with gh)" >&2; exit 1; }
  printf '%s' "${v}"
}
AWS_REGION="$(setting AWS_REGION)"
DOKKU_INSTANCE_ID="$(setting DOKKU_INSTANCE_ID)"
DEPLOY_ARTIFACT_BUCKET="$(setting DEPLOY_ARTIFACT_BUCKET)"
PUBLIC_URL="$(setting PUBLIC_URL)"
export AWS_REGION DOKKU_INSTANCE_ID DEPLOY_ARTIFACT_BUCKET

git fetch origin --quiet
ref="${1:-origin/main}"
sha="$(git rev-parse --verify "${ref}^{commit}")"

running="$(curl -sS --max-time 10 "${PUBLIC_URL%/}/v1/meta" 2>/dev/null | jq -r '.data.commit // empty' 2>/dev/null || true)"
echo "Deploying ${ref} = ${sha}"
echo "  $(git log -1 --format='%s (%an, %cr)' "${sha}")"
echo "Production now runs: ${running:-unknown (no /v1/meta commit)}"

if [ -z "${DEPLOY_EMBEDDING:-}" ]; then
  DEPLOY_EMBEDDING=false
  if [ -n "${running}" ] && git cat-file -e "${running}^{commit}" 2>/dev/null \
    && git diff --name-only "${running}" "${sha}" | grep -qx 'docker/Dockerfile.embedding'; then
    DEPLOY_EMBEDDING=true
  fi
fi
export DEPLOY_EMBEDDING
echo "Rebuild embedding image: ${DEPLOY_EMBEDDING}"

# Run the shipping scripts as they are in the commit being deployed, so a box deploy and a GitHub deploy of
# the same commit do exactly the same thing.
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
git archive "${sha}" deploy/dokku | tar -x -C "${work}"
bash "${work}/deploy/dokku/ship.sh" "${sha}"
bash "${work}/deploy/dokku/smoke.sh" "${PUBLIC_URL}" "${sha}"
echo "Production commit: $(curl -sS --max-time 10 "${PUBLIC_URL%/}/v1/meta" | jq -r '.data.commit')"
