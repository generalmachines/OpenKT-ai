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

(`openai` here only means "speak the OpenAI embeddings protocol"; nothing leaves the machine. Until built-in sign-in lands the server still wants the `SUPABASE_*` variables to be present; placeholders are fine when you only use access tokens.)

```
npm ci && npm run db:migrate && npm run build:api && npm run start:api
```

## 4. Test users and the proof

```
cd scripts/test-server
python3 seed-test-users.py | psql "$DATABASE_URL"      # writes tokens.env (never commit it)
set -a; . ./tokens.env; set +a
node ../live-proof.mjs                                  # 23 checks over REST + MCP; exits 1 on any failure
```

The proof is the product's promise: what the owner saves, a teammate with a grant retrieves — by meaning, with the author attached — and a stranger gets nothing, anywhere.

Point the desktop app at `http://<host>:3300` and paste the owner's token on the Connect screen.
