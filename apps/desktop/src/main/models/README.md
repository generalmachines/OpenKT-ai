# Local models and the local AI runtime

Interim on-device runtime: llama.cpp's `llama-server` (MIT), **bundled in the app** at
`Contents/Resources/llama/`, standing in for the Swift/MLX engine behind the `LocalAi`
interface (`../local-ai/local-ai.ts`). Models are **downloaded on first launch** into
`app.getPath('userData')/models/`. Nothing needs to be installed; no terminal.

| Path | Role |
|---|---|
| `models.manifest.json` | Pinned repo, HF revision, bytes, sha256 (LFS oid) per file + the pinned llama.cpp release (tag, sha256). Refresh: `node scripts/gen-models-manifest.mjs`. |
| `manifest.ts` | `chooseModels(manifest, totalmem)` — ≤ 8 GB RAM → Qwen3.5-2B, else Qwen3.5-4B. `OPENKT_MODEL_TIER=2b\|4b` overrides. |
| `downloader.ts` | Resume (HTTP Range on `<file>.part`), size + sha256 verify, atomic rename, progress ≤ 4/s, retry with backoff. Checksum mismatch → delete + `ChecksumError`. |
| `store.ts` | `ModelStore.status()` / `ensure()` — embeddings first, then LLM, then mmproj. Single-flight. |
| `../local-ai/supervisor.ts` | One `llama-server` child: free port on 127.0.0.1, `/health`, restart on crash (max 3), idle unload, kill on quit. |
| `../local-ai/local-ai.ts` | `LocalAi { ensureModels, status, chat, embed, stop }`. Chat: `--jinja -c 8192 -ngl 99 --reasoning off --reasoning-budget 0`, unloads after 5 idle minutes. Embed: `--embedding --pooling last`. |
| `../local-ai/agents.ts` | Runs `@openkt/agents` `summarise` + `extract` against the local chat server. |
| `../local-ai/ipc.ts` | Electron wiring. The only files that import `electron` are `ipc.ts` and `smoke.ts`; everything else also runs under plain Node (`scripts/smoke-local-ai.mjs`). |

## Renderer API (`window.openkt`, typed in `src/shared/ipc.ts`)

The main process starts the download by itself after the first window opens
(`autoEnsureModels`), so a first-run screen only has to **listen and render**.

```ts
const s = await window.openkt.models.status();
// s.tier: "llm-4b" | "llm-2b";  s.binaryFound: boolean
// s.models[]: { role: 'embed'|'llm'|'mmproj', file, totalBytes, receivedBytes,
//               state: 'missing'|'partial'|'downloading'|'ready'|'error', error? }
// s.servers.chat / .embed: { state: 'stopped'|'starting'|'ready'|'crashed'|'failed', port, pid, restarts, lastError }

const off = window.openkt.models.onProgress((p) => {
  // ≤ 4 events/s: { role, file, receivedBytes, totalBytes, bytesPerSec, overall (0..1), state, error? }
});

// Idempotent; joins a download already in flight. Use it for a "Retry" button.
const r = await window.openkt.models.ensure();   // { ok: true, status } | { ok: false, error, status }

const note = await window.openkt.localAi.extractNote({ text, title?, date?, source?, author? });
// → { title (≤ 8 words), summary, facts: [{ kind, statement, quote }], status: 'ok'|'partial'|'noop', latencyMs, notes }
// Every fact's quote has passed the quote gate (it occurs verbatim in `text`).
// First call after idle loads the model (seconds). Rejects if models are not downloaded yet.

const vectors = await window.openkt.localAi.embed(texts, 'query' | 'document'); // 1024-dim, unit norm
```

Suggested first-run UI: show `overall` as one bar with the current `file` beneath it;
on `state: 'error'` show `error` and a Retry button that calls `models.ensure()` —
the download resumes where it stopped. Sizes: embeddings 0.64 GB, 4B 2.74 GB (2B 1.28 GB), mmproj 0.67 GB.

## Environment switches

`OPENKT_MODELS_DIR`, `OPENKT_LLAMA_DIR`, `OPENKT_MODEL_TIER`, `OPENKT_NO_AUTO_MODELS=1`,
`OPENKT_SMOKE=1` (+ `OPENKT_SMOKE_OUT`) — the packaged-app self test CI runs.

## Not done yet

Vision: `mmproj` is downloaded but the chat server is not started with `--mmproj`, so
`describe_image` is not wired. No UI for choosing a models directory or deleting models.
