#!/usr/bin/env bash
# E2E smoke for the MCP/CLI ↔ NestJS BFF loop.
#
# Walks the full memory-engine round trip from an *MCP-shape caller*
# (POST /v1/memories with Authorization: Bearer <Supabase JWT>) through
# the BFF, the outbox, the worker pipeline, and back via
# POST /v1/memories/recall.
#
# Required env (none of these are read from secrets.env automatically —
# the operator drops them in shell or sources a local file):
#   OPENKT_API_BASE_URL          e.g. http://127.0.0.1:4100
#   OPENKT_TEST_BEARER_TOKEN     a Supabase access_token. The loop
#                                 expects this token to belong to the
#                                 same project we POST to.
#   OPENKT_TEST_PROJECT_ID       UUID of a project the caller can write.
#
# Optional:
#   OPENKT_TEST_CONTENT          memory body (default: timestamped probe)
#   OPENKT_TEST_RECALL_QUERY     recall query (default: same as content)
#   OPENKT_TEST_RECALL_DELAY_S   wait between create + recall (default 8)
#
# Exit codes:
#   0 = create + recall both succeed and the recalled set contains the
#       memory id we just wrote.
#   1 = config / connectivity error (BFF not reachable, missing env).
#   2 = create succeeded, recall did not return the memory inside the
#       wait window (pipeline lag or path break).

set -euo pipefail

bff_url="${OPENKT_API_BASE_URL:-}"
token="${OPENKT_TEST_BEARER_TOKEN:-}"
project_id="${OPENKT_TEST_PROJECT_ID:-}"
content="${OPENKT_TEST_CONTENT:-mcp-bff-loop probe $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
recall_query="${OPENKT_TEST_RECALL_QUERY:-${content}}"
delay_s="${OPENKT_TEST_RECALL_DELAY_S:-8}"

if [[ -z "$bff_url" || -z "$token" || -z "$project_id" ]]; then
  cat <<'EOF' >&2
[smoke] missing env. Required:
  OPENKT_API_BASE_URL
  OPENKT_TEST_BEARER_TOKEN
  OPENKT_TEST_PROJECT_ID

If you have a logged-in Supabase JWT in ~/.openkt/token already:
  export OPENKT_TEST_BEARER_TOKEN="$(cat ~/.openkt/token)"

To find an eligible project_id:
  curl -sH "Authorization: Bearer $OPENKT_TEST_BEARER_TOKEN" \
       "$OPENKT_API_BASE_URL/v1/projects" | jq -r '.data[0].id'
EOF
  exit 1
fi

echo "[smoke] BFF=$bff_url project=$project_id"

# Health gate — fail loud if the BFF is down before we waste a probe.
if ! curl -fsS "$bff_url/v1/internal/health/live" >/dev/null; then
  echo "[smoke] BFF not reachable at $bff_url/v1/internal/health/live" >&2
  exit 1
fi

# ── 1. POST /v1/memories ──
create_payload=$(jq -n \
  --arg pid "$project_id" \
  --arg content "$content" \
  '{
    project_id: $pid,
    content: $content,
    kind: "context",
    visibility: "project",
    confidence: 0.9,
    importance: 0.5,
    source_refs: []
  }')

create_resp=$(curl -sS -X POST \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d "$create_payload" \
  "$bff_url/v1/memories")

memory_id=$(jq -r '.data.id // empty' <<<"$create_resp")
if [[ -z "$memory_id" ]]; then
  echo "[smoke] create failed:" >&2
  echo "$create_resp" | jq . >&2 || echo "$create_resp" >&2
  exit 1
fi
echo "[smoke] created memory $memory_id"

# ── 2. Wait for the pipeline to land the embedding ──
echo "[smoke] sleeping ${delay_s}s for embed stage…"
sleep "$delay_s"

# ── 3. POST /v1/memories/recall ──
recall_payload=$(jq -n \
  --arg pid "$project_id" \
  --arg q "$recall_query" \
  '{
    project_id: $pid,
    query: $q,
    limit: 25
  }')

recall_resp=$(curl -sS -X POST \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d "$recall_payload" \
  "$bff_url/v1/memories/recall")

ids=$(jq -r '.data[].id // empty' <<<"$recall_resp")
if grep -qx "$memory_id" <<<"$ids"; then
  echo "[smoke] PASS — memory $memory_id round-tripped via recall"
  exit 0
fi

echo "[smoke] FAIL — recall did not return $memory_id within ${delay_s}s" >&2
echo "[smoke] recall response (head):" >&2
echo "$recall_resp" | jq '.data | length, (.data[0:3])' >&2 || echo "$recall_resp" >&2
exit 2
