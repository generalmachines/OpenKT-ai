#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/api-server.sh"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/supabase-auth.sh"
bootstrap_api_if_needed

if ! BEARER_TOKEN="$(mint_supabase_token)"; then
  echo "user settings round-trip skipped: provide OPENKT_TEST_BEARER_TOKEN or OPENKT_TEST_EMAIL and OPENKT_TEST_PASSWORD"
  exit 0
fi

original_result="$(capture_curl GET "${API_BASE_URL}/v1/settings/user" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "x-openkt-surface: cli" \
  -H "x-request-id: smoke-settings-get")"
original_status="$(printf '%s' "${original_result}" | head -n1)"
original_body="$(printf '%s' "${original_result}" | tail -n +2)"

if [[ "${original_status}" != "200" ]]; then
  echo "Expected 200 from settings/user GET, got ${original_status}" >&2
  echo "Payload: ${original_body}" >&2
  exit 1
fi

original_settings="$(printf '%s' "${original_body}" | json_eval "json.data.settings")"
smoke_value="checkpoint-$(date +%s)"
updated_settings="$(printf '%s' "${original_settings}" | node -e 'let data=\"\"; process.stdin.on(\"data\", (chunk) => data += chunk); process.stdin.on(\"end\", () => { const json = JSON.parse(data || \"{}\"); json.openktBffSmoke = { value: process.argv[1] }; process.stdout.write(JSON.stringify(json)); });' "${smoke_value}")"
restore_payload="{\"settings\":${original_settings}}"
update_payload="{\"settings\":${updated_settings}}"

restore_settings() {
  curl --silent --show-error --fail \
    --connect-timeout 5 --max-time 30 \
    "${API_BASE_URL}/v1/settings/user" \
    -X PUT \
    -H "Authorization: Bearer ${BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${restore_payload}" >/dev/null
}
trap restore_settings EXIT

update_result="$(capture_curl PUT "${API_BASE_URL}/v1/settings/user" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-openkt-surface: cli" \
  -d "${update_payload}")"
update_status="$(printf '%s' "${update_result}" | head -n1)"
update_body="$(printf '%s' "${update_result}" | tail -n +2)"

if [[ "${update_status}" != "200" ]]; then
  echo "Expected 200 from settings/user PUT, got ${update_status}" >&2
  echo "Payload: ${update_body}" >&2
  exit 1
fi

assert_contains "${update_body}" "${smoke_value}" "updated settings should include the smoke marker"

verify_result="$(capture_curl GET "${API_BASE_URL}/v1/settings/user" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "x-openkt-surface: cli")"
verify_status="$(printf '%s' "${verify_result}" | head -n1)"
verify_body="$(printf '%s' "${verify_result}" | tail -n +2)"

if [[ "${verify_status}" != "200" ]]; then
  echo "Expected 200 from settings/user verification GET, got ${verify_status}" >&2
  echo "Payload: ${verify_body}" >&2
  exit 1
fi

assert_contains "${verify_body}" "${smoke_value}" "verification GET should return the smoke marker"

restore_settings
trap - EXIT

echo "user settings round-trip smoke passed"
