#!/usr/bin/env bash
# One-time setup of the OpenKT apps on a Dokku host (run as root, e.g. through SSM). Idempotent.
# Follows the layout of the original backend: one Dokku app per component, Dockerfile builds from one
# source archive, a private Docker network between apps, internal apps without a vhost, state kept off the host.
#
#   DB_HOST=<rds endpoint>         (first run) the database host; the connection string template is read from the
#                                  encrypted SSM parameter /openkt-next/database-url-template (placeholder __HOST__)
#   DATABASE_URL=postgresql://…    (alternative to DB_HOST) a full connection string
#   DOMAINS="api.example.com mcp.example.com"   LE_EMAIL=admin@example.com   (optional) public names + TLS
set -euo pipefail
NET="${NET:-openkt-private}"; API=openkt-next-api; EMB=openkt-next-embedding

docker network inspect "$NET" >/dev/null 2>&1 || dokku network:create "$NET"

# ── embeddings (internal) ────────────────────────────────────────────────
dokku apps:exists "$EMB" 2>/dev/null || dokku apps:create "$EMB"
dokku builder:set "$EMB" selected dockerfile
dokku builder-dockerfile:set "$EMB" dockerfile-path docker/Dockerfile.embedding
dokku network:set "$EMB" attach-post-create "$NET"
dokku config:set --no-restart "$EMB" NO_VHOST=1 >/dev/null
dokku checks:disable "$EMB" >/dev/null 2>&1 || true

# ── API (public) ─────────────────────────────────────────────────────────
dokku apps:exists "$API" 2>/dev/null || dokku apps:create "$API"
dokku builder:set "$API" selected dockerfile
dokku builder-dockerfile:set "$API" dockerfile-path docker/Dockerfile.api
dokku ps:set "$API" procfile-path .dokku/Procfile.api
dokku network:set "$API" attach-post-create "$NET"
dokku ports:set "$API" http:80:4100

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  TEMPLATE="$(aws ssm get-parameter --region "${AWS_REGION:-ap-south-1}" --name /openkt-next/database-url-template --with-decryption --query Parameter.Value --output text)"
  DATABASE_URL="${TEMPLATE/__HOST__/$DB_HOST}"
fi

if [ -z "$(dokku config:get "$API" OPENKT_INTERNAL_SERVICE_TOKEN 2>/dev/null)" ] && [ -n "${DATABASE_URL:-}" ]; then
  dokku config:set --no-restart "$API" \
    NODE_ENV=production HOST=0.0.0.0 PORT=4100 LOG_LEVEL=info \
    DATABASE_URL="$DATABASE_URL" DATA_POSTGRES_URL="$DATABASE_URL" \
    OPENKT_MEMORY_ENGINE=local MEMORY_ENGINE=local OPENKT_INLINE_EMBED=true \
    OPENKT_EMBEDDING_BACKEND=openai OPENAI_API_KEY=local \
    OPENKT_OPENAI_EMBED_URL="http://${EMB}.web:8080/v1/embeddings" OPENKT_OPENAI_EMBED_MODEL="Qwen/Qwen3-Embedding-0.6B" \
    OPENKT_INTERNAL_SERVICE_TOKEN="$(openssl rand -hex 32)" OPENKT_MCP_SERVICE_KEY="$(openssl rand -hex 32)" \
    CORS_ALLOWED_ORIGINS="*" ${EXTRA_CONFIG:-} >/dev/null
fi

if [ -n "${DOMAINS:-}" ]; then
  dokku domains:set "$API" $DOMAINS
  if [ -n "${LE_EMAIL:-}" ]; then
    dokku plugin:list | grep -q letsencrypt || dokku plugin:install https://github.com/dokku/dokku-letsencrypt.git
    dokku letsencrypt:set "$API" email "$LE_EMAIL"
    # The certificate is requested after the first successful deploy (the app must answer on port 80):
    #   dokku letsencrypt:enable openkt-next-api && dokku letsencrypt:cron-job --add
  fi
fi
dokku apps:report "$API" | head -5
