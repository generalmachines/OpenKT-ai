#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/api-server.sh"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/supabase-auth.sh"
bootstrap_api_if_needed

if ! BEARER_TOKEN="$(mint_supabase_token)"; then
  echo "memory read smoke skipped: provide OPENKT_TEST_BEARER_TOKEN or OPENKT_TEST_EMAIL and OPENKT_TEST_PASSWORD"
  exit 0
fi

projects_result="$(capture_curl GET "${API_BASE_URL}/v1/projects" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "x-openkt-surface: cli" \
  -H "x-request-id: smoke-memory-projects")"
projects_status="$(printf '%s' "${projects_result}" | head -n1)"
projects_body="$(printf '%s' "${projects_result}" | tail -n +2)"

if [[ "${projects_status}" != "200" ]]; then
  echo "Expected 200 from projects list, got ${projects_status}" >&2
  echo "Payload: ${projects_body}" >&2
  exit 1
fi

project_id="$(printf '%s' "${projects_body}" | json_eval "json.data[0]?.id")"
if [[ -z "${project_id}" ]]; then
  echo "memory read smoke skipped: no projects available for the authenticated user"
  exit 0
fi

list_result="$(capture_curl GET "${API_BASE_URL}/v1/memories?project_id=${project_id}&limit=1" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "x-openkt-surface: cli" \
  -H "x-request-id: smoke-memory-list")"
list_status="$(printf '%s' "${list_result}" | head -n1)"
list_body="$(printf '%s' "${list_result}" | tail -n +2)"

if [[ "${list_status}" != "200" ]]; then
  echo "Expected 200 from memory list, got ${list_status}" >&2
  echo "Payload: ${list_body}" >&2
  exit 1
fi

assert_contains "${list_body}" '"meta":{' "memory list should return a paged envelope"

search_payload="{\"query\":\"\",\"mode\":\"keyword\",\"filters\":{\"project_ids\":[\"${project_id}\"]},\"limit\":1}"
search_result="$(capture_curl POST "${API_BASE_URL}/v1/memories/search" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-openkt-surface: cli" \
  -d "${search_payload}")"
search_status="$(printf '%s' "${search_result}" | head -n1)"
search_body="$(printf '%s' "${search_result}" | tail -n +2)"

if [[ "${search_status}" != "200" ]]; then
  echo "Expected 200 from memory search, got ${search_status}" >&2
  echo "Payload: ${search_body}" >&2
  exit 1
fi

assert_contains "${search_body}" '"embedding_model"' "memory search should return search metadata"

recall_payload="{\"project_id\":\"${project_id}\",\"query\":\"\",\"limit\":1}"
recall_result="$(capture_curl POST "${API_BASE_URL}/v1/memories/recall" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-openkt-surface: mcp" \
  -d "${recall_payload}")"
recall_status="$(printf '%s' "${recall_result}" | head -n1)"
recall_body="$(printf '%s' "${recall_result}" | tail -n +2)"

if [[ "${recall_status}" != "200" ]]; then
  echo "Expected 200 from memory recall, got ${recall_status}" >&2
  echo "Payload: ${recall_body}" >&2
  exit 1
fi

assert_contains "${recall_body}" '"query_ms"' "memory recall should return timing metadata"

echo "memory read smoke passed"
