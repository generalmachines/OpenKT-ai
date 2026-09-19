# Run a test server

A small, real deployment for trying the desktop app and MCP clients against: Postgres with pgvector, a local embedding service, the API. No broker, no worker, no third-party account.

## 1. Embeddings (llama.cpp, the same runtime the desktop app bundles)

```
# a release binary from https://github.com/ggml-org/llama.cpp/releases and the model:
curl -L -o emb.gguf https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf
llama-server -m emb.gguf --embedding --pooling last --host 127.0.0.1 --port 8091 -c 8192 -ub 8192
```

## 2. Database

```
docker run -d --name openkt-pg -e POSTGRES_USER=openkt -e POSTGRES_PASSWORD=openkt -e POSTGRES_DB=openkt -p 15432:5432 pgvector/pgvector:pg16
```

## 3. API

Create `server/.env` from `.env.example` and set at least:

```
PORT=3300
HOST=0.0.0.0
DATABASE_URL=postgres://openkt:openkt@127.0.0.1:15432/openkt
DATA_POSTGRES_URL=postgres://openkt:openkt@127.0.0.1:15432/openkt
OPENKT_MEMORY_ENGINE=local
OPENKT_INLINE_EMBED=true
OPENKT_EMBEDDING_BACKEND=openai
OPENKT_OPENAI_EMBED_URL=http://127.0.0.1:8091/v1/embeddings
OPENKT_OPENAI_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B
OPENAI_API_KEY=local
```

(`openai` here only means "speak the OpenAI embeddings protocol"; nothing leaves the machine. No `SUPABASE_*` variable is needed — sign-in is built in. For Google sign-in add `OPENKT_GOOGLE_CLIENT_IDS=<your OAuth client id>`; behind a reverse proxy add `OPENKT_TRUST_PROXY=1`.)

```
npm ci && npm run db:migrate && npm run build:api && npm run start:api
```

## 4. Accounts

People sign up themselves, through the API (any client's sign-up screen calls the same route):

```
curl -s http://127.0.0.1:3300/v1/auth/signup -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","display_name":"You"}'
# → { "data": { "token": "okt_pat_…", "expires_at": "…", "user": { "id", "email", "display_name" } } }
```

That token is the session: send it as `Authorization: Bearer okt_pat_…` to every `/v1/*` route and to `/mcp`. `POST /v1/auth/login` signs in again, `POST /v1/auth/logout` revokes the token. Share a space with a teammate by email (`PUT /v1/projects/:id/grants {"email","role"}`); if they have no account yet, the share waits and applies the moment they sign up.

## 5. The proof

```
OPENKT_LIVE_URL=http://127.0.0.1:3300 OPENKT_LIVE_SIGNUP=1 node scripts/live-proof.mjs
# 38 checks over REST + MCP; exits 1 on any failure
```

With `OPENKT_LIVE_SIGNUP=1` the script signs its own users up through the API (five per run; sign-ups are limited to 10 per address per 15 minutes), runs the core proof, then the accounts block: share by email before and after the teammate exists, recall through that share, log out, tokens rejected.

The proof is the product's promise: what the owner saves, a teammate with a grant retrieves — by meaning, with the author attached — and a stranger gets nothing, anywhere.

`seed-test-users.py` remains for one case: you need three fixed users with tokens WITHOUT going through sign-up (a CI job, a database you reset often). It writes SQL to stdout and the raw tokens to `./tokens.env` (never commit it):

```
cd scripts/test-server
python3 seed-test-users.py | psql "$DATABASE_URL"
set -a; . ./tokens.env; set +a
node ../live-proof.mjs                                  # the 23 core checks
```

Point the desktop app at `http://<host>:3300` and paste the token from sign-up on the Connect screen.
