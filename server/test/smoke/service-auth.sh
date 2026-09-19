#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT_DIR}/helpers/api-server.sh"
bootstrap_api_if_needed

# shellcheck disable=SC1090
source "${ENV_FILE}"
result="$(capture_curl GET "${API_BASE_URL}/v1/internal/auth/service" \
  -H "Authorization: Bearer ${OPENKT_INTERNAL_SERVICE_TOKEN}" \
  -H "x-openkt-service-name: smoke-service" \
  -H "x-openkt-surface: system" \
  -H "x-request-id: smoke-service-auth")"
status="$(printf '%s' "${result}" | head -n1)"
body="$(printf '%s' "${result}" | tail -n +2)"

if [[ "${status}" != "200" ]]; then
  echo "Expected 200 from service auth endpoint, got ${status}" >&2
  echo "Payload: ${body}" >&2
  exit 1
fi

assert_contains "${body}" '"authSource":"service-token"' "service auth should use service-token auth source"
assert_contains "${body}" '"serviceName":"smoke-service"' "service auth should preserve service name"
assert_contains "${body}" '"surface":"system"' "service auth should preserve request surface"

echo "service auth smoke passed"
