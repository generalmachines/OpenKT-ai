#!/usr/bin/env bash
#
# embed-chain smoke — drives a single memory through the full pipeline and
# verifies every stage on the way:
#
#   POST /v1/memories          (SGS HTTP)
#   → outbox_events.published_at  (worker outbox-relay published it to MQ)
#   → agentic_jobs[stage=embed].status='done'  (embedding worker ran)
#   → memories.embedding IS NOT NULL  (BGE-M3 vector landed in row)
#   → agentic_jobs[stage=briefing].status='done'  (final stage closed the chain)
#
# The script does NOT mock anything. It needs a live SGS API + worker pair
# pointed at a real Supabase + RabbitMQ + BGE TEI. Use it to prove the
# pipeline end-to-end on localhost (or staging) before declaring victory on
# any change that touches MQ, embeddings, or the worker stages.
#
# Required env (in your shell or test/fixtures/api.env):
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
#   OPENKT_TEST_BEARER_TOKEN   (or OPENKT_TEST_EMAIL + OPENKT_TEST_PASSWORD)
#
# Optional:
#   API_BASE_URL               default http://127.0.0.1:4110
#   EMBED_CHAIN_PROJECT_ID     pin to a known project; otherwise the first
#                              project the bearer can list is used
#   EMBED_CHAIN_TIMEOUT        seconds to wait for the chain to complete
#                              (default 60). BGE TEI cold start can be 20s+
#                              so don't set this too low.
#   OPENKT_SKIP_API_BOOTSTRAP=1 if you have SGS already running and don't
#                              want the smoke harness to start its own
#
set -euo pipefail

TEST_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/api-server.sh"
# shellcheck disable=SC1091
source "${TEST_ROOT_DIR}/helpers/supabase-auth.sh"

bootstrap_api_if_needed
load_env_file

: "${SUPABASE_URL:?embed-chain smoke needs SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?embed-chain smoke needs SUPABASE_SERVICE_ROLE_KEY (worker stages + embedding column are admin-only)}"

if ! BEARER_TOKEN="$(mint_supabase_token)"; then
  echo "embed-chain smoke skipped: provide OPENKT_TEST_BEARER_TOKEN or OPENKT_TEST_EMAIL/OPENKT_TEST_PASSWORD" >&2
  exit 0
fi

TIMEOUT_SECONDS="${EMBED_CHAIN_TIMEOUT:-60}"
RUN_ID="$(date +%s)-$$"

# --- 1. Pick a project ------------------------------------------------------
project_id="${EMBED_CHAIN_PROJECT_ID:-}"
if [[ -z "${project_id}" ]]; then
  projects_result="$(capture_curl GET "${API_BASE_URL}/v1/projects" \
    -H "Authorization: Bearer ${BEARER_TOKEN}" \
    -H "x-openkt-surface: cli" \
    -H "x-request-id: smoke-embed-chain-projects-${RUN_ID}")"
  projects_status="$(printf '%s' "${projects_result}" | head -n1)"
  projects_body="$(printf '%s' "${projects_result}" | tail -n +2)"
  if [[ "${projects_status}" != "200" ]]; then
    echo "GET /v1/projects → ${projects_status}: ${projects_body}" >&2
    exit 1
  fi
  project_id="$(printf '%s' "${projects_body}" | json_eval "json.data[0]?.id" || true)"
  if [[ -z "${project_id}" ]]; then
    echo "embed-chain smoke skipped: no projects available for this user — set EMBED_CHAIN_PROJECT_ID" >&2
    exit 0
  fi
fi
echo "embed-chain: project_id=${project_id}"

# --- 2. POST a fresh memory -------------------------------------------------
content="embed-chain smoke probe ${RUN_ID} — verifies MQ + BGE-M3 + briefing"
create_payload="$(node -e "process.stdout.write(JSON.stringify({
  project_id: '${project_id}',
  kind: 'note',
  visibility: 'project',
  content: process.argv[1],
  tag_slugs: ['smoke','embed-chain']
}))" "${content}")"

create_result="$(capture_curl POST "${API_BASE_URL}/v1/memories" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-openkt-surface: cli" \
  -H "x-request-id: smoke-embed-chain-create-${RUN_ID}" \
  -d "${create_payload}")"
create_status="$(printf '%s' "${create_result}" | head -n1)"
create_body="$(printf '%s' "${create_result}" | tail -n +2)"
if [[ "${create_status}" != "201" && "${create_status}" != "200" ]]; then
  echo "POST /v1/memories → ${create_status}: ${create_body}" >&2
  exit 1
fi

memory_id="$(printf '%s' "${create_body}" | json_eval "json.data?.id" || true)"
if [[ -z "${memory_id}" ]]; then
  echo "POST /v1/memories returned no data.id; body: ${create_body}" >&2
  exit 1
fi
echo "embed-chain: memory_id=${memory_id}"
created_at_epoch="$(date +%s)"

# --- 3. Helpers for PostgREST queries ---------------------------------------
pg() {
  # pg <query-suffix>  e.g. pg "agentic_jobs?memory_id=eq.${memory_id}&select=stage,status,error"
  curl --silent --show-error --fail \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "${SUPABASE_URL}/rest/v1/$1"
}

wait_until() {
  # wait_until <label> <expr> <jq-test> — poll up to TIMEOUT_SECONDS
  local label="$1" pg_query="$2" js_predicate="$3"
  local deadline=$(( created_at_epoch + TIMEOUT_SECONDS ))
  while :; do
    local body
    body="$(pg "${pg_query}" || true)"
    if printf '%s' "${body}" | node -e "
      let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
        const json=JSON.parse(s||'[]');
        process.exit((${js_predicate}) ? 0 : 1);
      });" 2>/dev/null; then
      printf '  ✓ %s\n' "${label}"
      printf '%s' "${body}"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      echo "  ✗ ${label} — timed out after ${TIMEOUT_SECONDS}s" >&2
      echo "    last response: ${body}" >&2
      return 1
    fi
    sleep 1
  done
}

fail_count=0
note_fail() { fail_count=$(( fail_count + 1 )); }

# --- 4. Outbox event published ---------------------------------------------
echo "embed-chain: waiting on outbox publication"
wait_until "outbox_events.published_at set" \
  "outbox_events?aggregate_id=eq.${memory_id}&select=event_type,published_at,attempts,last_error" \
  "Array.isArray(json) && json.some(r => r.published_at) || (json.length && (function(){console.error('outbox attempts:', JSON.stringify(json)); return false;})())" \
  >/dev/null || note_fail

# --- 5. Embed stage done + embedding column populated ----------------------
echo "embed-chain: waiting on embed stage"
wait_until "agentic_jobs[stage=embed].status=done" \
  "agentic_jobs?memory_id=eq.${memory_id}&stage=eq.embed&select=stage,status,attempts,error" \
  "Array.isArray(json) && json.some(r => r.status === 'done')" \
  >/dev/null || note_fail

echo "embed-chain: waiting on memories.embedding"
wait_until "memories.embedding NOT NULL" \
  "memories?id=eq.${memory_id}&select=id,embedding" \
  "Array.isArray(json) && json[0] && json[0].embedding != null" \
  >/dev/null || note_fail

# Sanity-check vector dim — pgvector serializes as '[v1,v2,...]'.
embed_body="$(pg "memories?id=eq.${memory_id}&select=embedding" || true)"
embed_dim="$(printf '%s' "${embed_body}" | node -e "
  let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
    const j=JSON.parse(s||'[]');
    const v=j[0]?.embedding;
    if (typeof v === 'string') {
      const parts=v.replace(/^\[|\]$/g,'').split(',').filter(Boolean);
      process.stdout.write(String(parts.length));
    } else if (Array.isArray(v)) {
      process.stdout.write(String(v.length));
    } else {
      process.stdout.write('0');
    }
  });" || echo 0)"
if [[ "${embed_dim}" == "1024" ]]; then
  echo "  ✓ embedding dim=1024 (BGE-M3)"
else
  echo "  ✗ embedding dim=${embed_dim} (want 1024)" >&2
  note_fail
fi

# --- 6. Briefing stage done -------------------------------------------------
echo "embed-chain: waiting on briefing stage"
wait_until "agentic_jobs[stage=briefing].status=done" \
  "agentic_jobs?memory_id=eq.${memory_id}&stage=eq.briefing&select=stage,status,attempts,error" \
  "Array.isArray(json) && json.some(r => r.status === 'done')" \
  >/dev/null || note_fail

# --- 7. Stage roll-up summary ----------------------------------------------
roll_up="$(pg "agentic_jobs?memory_id=eq.${memory_id}&select=stage,status,attempts,error&order=started_at.asc" || true)"
echo "embed-chain: stage roll-up:"
printf '%s\n' "${roll_up}" | node -e "
  let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
    const j=JSON.parse(s||'[]');
    if(!j.length){console.log('  (no agentic_jobs rows)');return;}
    for(const r of j) console.log('  ' + r.stage.padEnd(10) + ' ' + r.status + (r.error ? ('  err='+r.error) : ''));
  });"

if (( fail_count > 0 )); then
  echo "embed-chain smoke FAILED: ${fail_count} check(s) did not pass" >&2
  exit 1
fi

echo "embed-chain smoke passed (memory_id=${memory_id})"
