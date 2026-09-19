#!/usr/bin/env bash
#
# mcp-tools-list smoke — proves the new /v1/mcp streamable-HTTP endpoint
# is alive and advertises the OpenKT memory tools.
#
# Sends a JSON-RPC `tools/list` over HTTP POST. Stateless transport, so
# no init handshake required (the SDK accepts list/call directly when
# `sessionIdGenerator: undefined`). Skipped when no bearer is available
# — same behaviour as memory-read.sh.
#
set -euo pipefail

TEST_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/api-server.sh"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/supabase-auth.sh"

bootstrap_api_if_needed

if ! BEARER_TOKEN="$(mint_supabase_token)"; then
  echo "mcp tools-list smoke skipped: provide OPENKT_TEST_BEARER_TOKEN or OPENKT_TEST_EMAIL/OPENKT_TEST_PASSWORD"
  exit 0
fi

# tools/list: enumerate every tool the server registered. The MCP
# Streamable HTTP transport requires both content types on Accept.
result="$(capture_curl POST "${API_BASE_URL}/v1/mcp" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-openkt-surface: mcp" \
  -H "x-request-id: smoke-mcp-tools-list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
status="$(printf '%s' "${result}" | head -n1)"
body="$(printf '%s' "${result}" | tail -n +2)"

if [[ "${status}" != "200" ]]; then
  echo "POST /v1/mcp tools/list → ${status}: ${body}" >&2
  exit 1
fi

assert_contains "${body}" '"memory_remember"' "tools/list should advertise memory_remember"
assert_contains "${body}" '"memory_recall"'   "tools/list should advertise memory_recall"
assert_contains "${body}" '"memory_search"'   "tools/list should advertise memory_search"
assert_contains "${body}" '"memory_forget"'   "tools/list should advertise memory_forget"

echo "mcp tools-list smoke passed"
