#!/usr/bin/env bash
set -euo pipefail

OPENKT_BFF_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT_DIR="$(cd "${OPENKT_BFF_ROOT_DIR}/.." && pwd)"
API_PORT="${API_PORT:-4110}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:${API_PORT}}"
DEFAULT_ENV_FILE="${OPENKT_BFF_ROOT_DIR}/test/fixtures/api.env"
if [[ -f "${REPO_ROOT_DIR}/.env.local" ]]; then
  DEFAULT_RUNTIME_ENV_FILE="${REPO_ROOT_DIR}/.env.local"
elif [[ -f "${REPO_ROOT_DIR}/.env" ]]; then
  DEFAULT_RUNTIME_ENV_FILE="${REPO_ROOT_DIR}/.env"
elif [[ -f "${OPENKT_BFF_ROOT_DIR}/.env.local" ]]; then
  DEFAULT_RUNTIME_ENV_FILE="${OPENKT_BFF_ROOT_DIR}/.env.local"
elif [[ -f "${OPENKT_BFF_ROOT_DIR}/.env" ]]; then
  DEFAULT_RUNTIME_ENV_FILE="${OPENKT_BFF_ROOT_DIR}/.env"
else
  DEFAULT_RUNTIME_ENV_FILE="${DEFAULT_ENV_FILE}"
fi
ENV_FILE="${ENV_FILE:-${DEFAULT_RUNTIME_ENV_FILE}}"
API_LOG_FILE="${API_LOG_FILE:-${OPENKT_BFF_ROOT_DIR}/test/.tmp/server.log}"
API_PID=""

ensure_built() {
  (cd "${OPENKT_BFF_ROOT_DIR}" && npm run build >/dev/null)
}

start_api_server() {
  ensure_built
  mkdir -p "${OPENKT_BFF_ROOT_DIR}/test/.tmp"
  load_env_file
  PORT="${API_PORT}" \
    node "${OPENKT_BFF_ROOT_DIR}/dist/apps/server/apps/server/src/main.js" \
    >"${API_LOG_FILE}" 2>&1 &
  API_PID="$!"
  export API_PID
  wait_for_api_server
}

load_env_file() {
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
}

wait_for_api_server() {
  local attempt
  for attempt in $(seq 1 40); do
    if curl --silent --show-error --fail \
      --connect-timeout 1 --max-time 2 \
      "${API_BASE_URL}/v1/internal/health/live" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  echo "API server failed to become ready. Log follows:" >&2
  cat "${API_LOG_FILE}" >&2
  return 1
}

stop_api_server() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    local attempt
    for attempt in $(seq 1 20); do
      if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "${API_PID}" >/dev/null 2>&1; then
      kill -9 "${API_PID}" >/dev/null 2>&1 || true
    fi
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
}

bootstrap_api_if_needed() {
  if [[ "${OPENKT_SKIP_API_BOOTSTRAP:-0}" == "1" ]]; then
    return 0
  fi
  start_api_server
  trap stop_api_server EXIT
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    echo "Assertion failed: ${message}" >&2
    echo "Expected to find: ${needle}" >&2
    echo "Actual payload: ${haystack}" >&2
    return 1
  fi
}

capture_curl() {
  local method="$1"
  local url="$2"
  shift 2
  local tmp
  tmp="$(mktemp)"
  local status
  status="$(curl --silent --show-error \
    --connect-timeout 5 --max-time 30 \
    -o "${tmp}" -w "%{http_code}" -X "${method}" "$url" "$@")"
  local body
  body="$(cat "${tmp}")"
  rm -f "${tmp}"
  printf '%s\n%s' "${status}" "${body}"
}

json_eval() {
  local expression="$1"
  node -e "let data=''; process.stdin.on('data', (chunk) => data += chunk); process.stdin.on('end', () => { const json = JSON.parse(data); const result = (${expression}); if (result === undefined || result === null) process.exit(1); if (typeof result === 'object') process.stdout.write(JSON.stringify(result)); else process.stdout.write(String(result)); });"
}
