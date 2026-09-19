#!/usr/bin/env bash
# Ship one commit to the Dokku host: git archive (+ build-info.json) → S3 ci/<sha> → Systems Manager →
# `dokku git:from-archive`, which builds the image, runs the release-phase migrations and the app.json
# healthcheck before it moves traffic. The ONE implementation of the deploy, shared by
# .github/workflows/deploy-dokku.yml and scripts/deploy-from-box.sh. Run from the repository root.
#
#   deploy/dokku/ship.sh <commit-sha>
#
# Environment: AWS_REGION, DOKKU_INSTANCE_ID, DEPLOY_ARTIFACT_BUCKET (the GitHub environment `production`
# holds all three), DEPLOY_EMBEDDING=true|false (default false: rebuild openkt-next-embedding too).
set -euo pipefail

sha="${1:?usage: deploy/dokku/ship.sh <commit-sha>}"
: "${AWS_REGION:?}" "${DOKKU_INSTANCE_ID:?}" "${DEPLOY_ARTIFACT_BUCKET:?}"
embedding="${DEPLOY_EMBEDDING:-false}"
sha="$(git rev-parse --verify "${sha}^{commit}")"

# 1. Immutable source archive. build-info.json is how the running server learns its own commit (GET /v1/meta):
#    it rides inside the image, so it cannot disagree with the code that is running.
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
build_info="$(jq -cn --arg commit "${sha}" --arg built_at "${built_at}" '{commit: $commit, built_at: $built_at}')"
archive="$(mktemp -t openkt-next.XXXXXX.tar)"
artifact_uri="s3://${DEPLOY_ARTIFACT_BUCKET}/ci/${sha}/openkt-next.tar"
cleanup() {
  rm -f "${archive}"
  aws s3 rm "${artifact_uri}" --region "${AWS_REGION}" --only-show-errors 2>/dev/null || true
}
trap cleanup EXIT
# Only what the images need — keeps the archive small.
git archive --format=tar --output="${archive}" --add-virtual-file="build-info.json:${build_info}" \
  "${sha}" server docker .dokku .dockerignore
aws s3 cp "${archive}" "${artifact_uri}" --region "${AWS_REGION}" --only-show-errors
echo "Uploaded ${artifact_uri} (${build_info})"

# 2. The host side. SSM returns only the last 24 000 characters of output, which once hid the real error of a
#    failed build, so each app's full build log goes to /var/log/openkt-next-deploy on the host and only its
#    tail comes back here. The host-wide lock serializes deploys from GitHub and from a workstation.
parameters="$(
  jq -cn --arg artifact "${artifact_uri}" --arg sha "${sha}" --arg embedding "${embedding}" '{
    commands: [
      "if [ -z \"${BASH_VERSION:-}\" ]; then exec /bin/bash \"$0\" \"$@\"; fi",
      "set -euo pipefail",
      ("ARTIFACT_URI=" + ($artifact | @sh)),
      ("SHA=" + ($sha | @sh)),
      "LOG_DIR=/var/log/openkt-next-deploy; mkdir -p \"${LOG_DIR}\"; find \"${LOG_DIR}\" -name \"*.log\" -mtime +30 -delete || true",
      "exec 9>/var/lock/openkt-next-deploy.lock",
      "flock -w 1800 9 || { echo \"another deploy held the host lock for 30 minutes\"; exit 1; }",
      "deploy_app() { local log=\"${LOG_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}-$1.log\"; echo \"-----> Deploying $1 at ${SHA} (full log on the host: ${log})\"; if aws s3 cp \"${ARTIFACT_URI}\" - --only-show-errors | dokku git:from-archive \"$1\" -- >\"${log}\" 2>&1; then grep -E \"^(=====|----->)\" \"${log}\" | tail -n 25 || true; else tail -n 150 \"${log}\"; echo \"-----> Deploy of $1 FAILED; the previous release keeps serving\"; return 1; fi; }",
      (if $embedding == "true" then "deploy_app openkt-next-embedding" else "echo \"-----> Embedding image unchanged; skipping\"" end),
      "dokku ps:set openkt-next-api procfile-path .dokku/Procfile.api",
      "dokku app-json:set openkt-next-api appjson-path .dokku/app.json",
      "dokku nginx:set openkt-next-api client-max-body-size 4m",
      "deploy_app openkt-next-api",
      "for app in openkt-next-api openkt-next-embedding; do echo \"== ${app}\"; dokku ps:report \"${app}\" | grep -E \"Running|Status web|restart policy\" || true; done"
    ]
  }'
)"
command_id="$(
  aws ssm send-command \
    --region "${AWS_REGION}" \
    --instance-ids "${DOKKU_INSTANCE_ID}" \
    --document-name AWS-RunShellScript \
    --comment "Deploy OpenKT next ${sha}" \
    --timeout-seconds 2400 \
    --parameters "${parameters}" \
    --query "Command.CommandId" \
    --output text
)"
echo "SSM command ${command_id}"
last=""
while true; do
  if invocation="$(aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${command_id}" \
    --instance-id "${DOKKU_INSTANCE_ID}" --output json 2>/dev/null)"; then
    status="$(jq -r ".Status" <<<"${invocation}")"
  else
    status="Pending"; invocation=""
  fi
  case "${status}" in
    Success)
      jq -r ".StandardOutputContent" <<<"${invocation}"; exit 0 ;;
    Failed|TimedOut|Cancelled|Cancelling|DeliveryTimedOut|ExecutionTimedOut|Undeliverable|Terminated)
      jq -r ".StandardOutputContent, .StandardErrorContent" <<<"${invocation}"
      echo "Deploy ${status}"; exit 1 ;;
    *)
      [ "${status}" = "${last}" ] || echo "SSM deployment status: ${status}"
      last="${status}"; sleep 10 ;;
  esac
done
