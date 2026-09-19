#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT_DIR}/helpers/api-server.sh"
bootstrap_api_if_needed

result="$(capture_curl GET "${API_BASE_URL}/v1/profile/me" -H "x-request-id: smoke-unauthorized")"
status="$(printf '%s' "${result}" | head -n1)"
body="$(printf '%s' "${result}" | tail -n +2)"

if [[ "${status}" != "401" ]]; then
  echo "Expected 401 from unauthorized profile endpoint, got ${status}" >&2
  echo "Payload: ${body}" >&2
  exit 1
fi

assert_contains "${body}" '"code":"unauthorized"' "unauthorized response should use the standard error code"
assert_contains "${body}" '"request_id":"smoke-unauthorized"' "error envelope should preserve request_id"
assert_contains "${body}" '"data":null' "error envelope should null out data"

echo "error envelope smoke passed"
