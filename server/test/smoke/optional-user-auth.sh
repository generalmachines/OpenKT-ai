#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/api-server.sh"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/supabase-auth.sh"
bootstrap_api_if_needed

if ! BEARER_TOKEN="$(mint_supabase_token)"; then
  echo "optional user auth smoke skipped: provide OPENKT_TEST_BEARER_TOKEN or OPENKT_TEST_EMAIL and OPENKT_TEST_PASSWORD"
  exit 0
fi

me_result="$(capture_curl GET "${API_BASE_URL}/v1/internal/auth/me" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "x-openkt-surface: cli" \
  -H "x-request-id: smoke-user-auth")"
me_status="$(printf '%s' "${me_result}" | head -n1)"
me_body="$(printf '%s' "${me_result}" | tail -n +2)"

if [[ "${me_status}" != "200" ]]; then
  echo "Expected 200 from user auth endpoint, got ${me_status}" >&2
  echo "Payload: ${me_body}" >&2
  exit 1
fi

assert_contains "${me_body}" '"authSource":"supabase-jwt"' "user auth should verify bearer tokens via Supabase"
assert_contains "${me_body}" '"surface":"cli"' "user auth should preserve the CLI surface"

profile_result="$(capture_curl GET "${API_BASE_URL}/v1/profile/me" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "x-openkt-surface: cli")"
profile_status="$(printf '%s' "${profile_result}" | head -n1)"
profile_body="$(printf '%s' "${profile_result}" | tail -n +2)"

if [[ "${profile_status}" != "200" ]]; then
  echo "Expected 200 from profile/me with a valid bearer token, got ${profile_status}" >&2
  echo "Payload: ${profile_body}" >&2
  exit 1
fi

assert_contains "${profile_body}" '"data":' "profile endpoint should return a success envelope"

echo "optional user auth smoke passed"
