#!/usr/bin/env bash
# After a deploy: prove the public endpoint runs the commit that was just shipped.
#   deploy/dokku/smoke.sh <public-url> <expected-commit-sha>
# Passes when GET <url>/v1/meta reports that commit AND an authenticated route refuses a request without a
# token (401). Every failed attempt prints why — curl's own error, not just "000" — and a final failure
# prints DNS, TLS and HTTP diagnostics so the cause is in the log.
set -euo pipefail

url="${1:?usage: deploy/dokku/smoke.sh <public-url> <expected-commit-sha>}"
url="${url%/}"
expected="${2:?usage: deploy/dokku/smoke.sh <public-url> <expected-commit-sha>}"
attempts="${SMOKE_ATTEMPTS:-36}"
err="$(mktemp)"
trap 'rm -f "${err}"' EXIT

for i in $(seq 1 "${attempts}"); do
  body="$(curl -sS --max-time 10 -w '\n%{http_code}' "${url}/v1/meta" 2>"${err}" || true)"
  code="$(tail -n 1 <<<"${body}")"
  commit="$(sed '$d' <<<"${body}" | jq -r '.data.commit // empty' 2>/dev/null || true)"
  if [ "${code}" = "200" ] && [ "${commit}" = "${expected}" ]; then
    auth="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "${url}/v1/projects" 2>"${err}" || true)"
    if [ "${auth}" = "401" ]; then
      echo "OK: ${url} runs ${commit}"
      sed '$d' <<<"${body}" | jq -c '.data'
      exit 0
    fi
    echo "attempt ${i}: /v1/meta is right but /v1/projects answered ${auth} (want 401) $(cat "${err}")"
  else
    echo "attempt ${i}: /v1/meta → ${code:-000}, commit ${commit:-none} (want ${expected}) $(cat "${err}")"
  fi
  sleep 5
done

host="$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"${url}")"
echo "::group::Diagnostics for ${host}"
echo "A:    $(dig +short A "${host}" 2>/dev/null | tr '\n' ' ')"
echo "AAAA: $(dig +short AAAA "${host}" 2>/dev/null | tr '\n' ' ')"
curl -sv --max-time 10 -o /dev/null "${url}/v1/meta" 2>&1 | grep -E '^\* |^< HTTP' | head -20 || true
echo "::endgroup::"
echo "Smoke test failed: ${url} does not serve ${expected}"
exit 1
