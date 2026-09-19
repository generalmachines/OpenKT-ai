#!/usr/bin/env bash
set -euo pipefail

OPENKT_BFF_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "${OPENKT_BFF_ROOT_DIR}/test/helpers/api-server.sh"

mint_supabase_token() {
  if [[ -n "${OPENKT_TEST_BEARER_TOKEN:-}" ]]; then
    printf '%s' "${OPENKT_TEST_BEARER_TOKEN}"
    return 0
  fi

  load_env_file

  local email="${OPENKT_TEST_EMAIL:-}"
  local password="${OPENKT_TEST_PASSWORD:-}"
  if [[ -z "${email}" || -z "${password}" ]]; then
    return 1
  fi

  local response
  response="$(curl --silent --show-error --fail \
    --connect-timeout 10 --max-time 30 \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\"}")"

  printf '%s' "${response}" | json_eval "json.access_token"
}
