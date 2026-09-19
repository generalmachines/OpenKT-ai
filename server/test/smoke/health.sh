#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT_DIR}/helpers/api-server.sh"
bootstrap_api_if_needed

live_payload="$(curl --silent --show-error --fail "${API_BASE_URL}/v1/internal/health/live")"
ready_payload="$(curl --silent --show-error --fail "${API_BASE_URL}/v1/internal/health/ready")"

assert_contains "${live_payload}" '"status":"ok"' "live check should return ok"
assert_contains "${live_payload}" '"service":"server"' "live check should identify the API service"
assert_contains "${ready_payload}" '"config":true' "ready check should report config readiness"
assert_contains "${ready_payload}" '"http":true' "ready check should report http readiness"

echo "health smoke passed"
