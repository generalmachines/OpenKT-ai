# Local models and the local AI runtime

Interim on-device runtime: llama.cpp's `llama-server` (MIT), **bundled in the app** at
`Contents/Resources/llama/`, standing in for the Swift/MLX engine behind the `LocalAi`
interface (`../local-ai/local-ai.ts`). Models are **downloaded on first launch** into
`app.getPath('userData')/models/`. Nothing needs to be installed; no terminal.

| Path | Role |
|---|---|
| `models.manifest.json` | Pinned repo, HF revision, bytes, sha256 (LFS oid) per file + the pinned llama.cpp release (tag, sha256). Refresh: `node scripts/gen-models-manifest.mjs`. |
| `manifest.ts` | `chooseModels(manifest, totalmem)` — ≤ 8 GB RAM → Qwen3.5-2B + whisper `small`, else Qwen3.5-4B + whisper `large-v3-turbo-q5_0`. `OPENKT_MODEL_TIER=2b\|4b` and `OPENKT_WHISPER_MODEL=turbo\|small\|base` override (`base` is for CI). |
| `downloader.ts` | Resume (HTTP Range on `<file>.part`), size + sha256 verify, atomic rename, progress ≤ 4/s, retry with backoff. Checksum mismatch → delete + `ChecksumError`. |
| `store.ts` | `ModelStore.status()` / `ensure()` — embeddings first, then LLM, then whisper, then mmproj. Single-flight. |
| `../local-ai/supervisor.ts` | One `llama-server` child: free port on 127.0.0.1, `/health`, restart on crash (max 3), idle unload, kill on quit. |
| `../local-ai/local-ai.ts` | `LocalAi { ensureModels, status, chat, embed, stop }`. Chat: `--jinja -c 8192 -ngl 99 --reasoning off --reasoning-budget 0`, plus `--mmproj <file>` once the projector is on disk (then `/v1/chat/completions` accepts `image_url` data URIs); unloads after 5 idle minutes. Embed: `--embedding --pooling last`. |
| `../local-ai/agents.ts` | Runs `@openkt/agents` `summarise` + `extract` against the local chat server. |
| `../capture/` | Voice notes and screenshots — see "Capture" below. |
| `../local-ai/ipc.ts` | Electron wiring. The only files that import `electron` are `ipc.ts` and `smoke.ts`; everything else also runs under plain Node (`scripts/smoke-local-ai.mjs`). |

## Renderer API (`window.openkt`, typed in `src/shared/ipc.ts`)

The main process starts the download by itself after the first window opens
(`autoEnsureModels`), so a first-run screen only has to **listen and render**.

```ts
const s = await window.openkt.models.status();
// s.tier: "llm-4b" | "llm-2b";  s.binaryFound: boolean
// s.models[]: { role: 'embed'|'llm'|'whisper'|'mmproj', file, totalBytes, receivedBytes,
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
the download resumes where it stopped. Sizes: embeddings 0.64 GB, 4B 2.74 GB (2B 1.28 GB), whisper 0.57 GB (`small` 0.49 GB), mmproj 0.67 GB.
`models.ensure()` resolves once embeddings + LLM are on disk; whisper and mmproj continue in the background and
show up in `models.status()` / `onProgress` like the others.

### First run: the person chooses, then one download

**Nothing is downloaded until the person chooses** — on the first-run screen ("Download models" / "Later"),
in Settings → Models, or where a feature needs its model (the voice pill offers just the speech model).
The screen lists each open-source model with its job, size, licence and Hugging Face model card, all from
`models.manifest.json` (`name`, `model`, `license`; `scripts/gen-models-manifest.mjs` refreshes the licence
from the card). The choice is saved in `userData/models-choice.json`; `autoEnsureModels` only finishes a
download that was chosen (a quit or a lost connection), it never starts one.

`controller.ts` is the one download for the whole app, so Pause means pause everywhere. It is a queue,
one file at a time: `ensure()` queues everything (search + understanding first, resolves when those two
are on disk), `ensure(['whisper'])` puts the speech model next and resolves when it is on disk. A pause
or a failure keeps the queue, so Resume / Try again continue the same models. Free space for what was
asked is checked before every run (`setup.ts`: `statfs` on the models folder, remaining bytes + 1 GB).

```ts
const info = await window.openkt.models.setupInfo();
// { totalBytes, remainingBytes, freeBytes | null, neededBytes, enoughDisk, totalMemBytes,
//   smallModel (≤ 8 GB → the 2B line-up), paused, bundled: { runtime, transcriber, textReader } }
// info.chosen: false until the person chose to download anything
await window.openkt.models.ensure();              // everything (the person's choice)
await window.openkt.models.ensure(['whisper']);   // just the speech model, first in line
await window.openkt.models.pause();               // keeps the .part files
await window.openkt.models.resume();              // continues the queued models
// ensure() → { ok: false, error: 'low_disk' | 'paused' | <message> } when it did not finish
// models.status().models[i] also carries { name, license, card, source } for the list
```

macOS permissions live in `../permissions/` (`service.ts` is the state machine, `ipc.ts` the Electron
wiring): `permissions.status() / request(kind) / openSettings(kind) / onChange(cb) / relaunch()`, kinds
`microphone | screen | accessibility | systemAudio`, states `granted | denied | not-determined | restricted | unsupported`.
Main polls every 1.5 s while a window is watching and re-checks on focus. What only a real Mac can
confirm is listed in [`docs/manual-test-permissions.md`](../../../docs/manual-test-permissions.md).

## Capture: voice notes and screenshots (`../capture/`)

Interim runtime of Spec 03 §1a. Nothing here streams: whisper runs once, after the recording ends.

| Path | Role |
|---|---|
| `wav.ts` | 16 kHz mono PCM16 → RIFF/WAVE; duration and RMS level. |
| `whisper.ts` | Runs the bundled `whisper-cli -m <model> -f <wav> -l auto -t <n> -oj -of <base> -np`; a crash or non-zero exit on the GPU path → retry with `-ng` (CPU) and stay there. |
| `transcript.ts` | Parses whisper's `-oj` JSON; drops `[BLANK_AUDIO]`-style segments. Cleanup is **code only**: a fixed list of English filler sounds (`um uh er erm ah hmm …` — never "like" or "you know"), and repeated words collapsed in any script. A model never rewrites a transcript. |
| `voice.ts` | `VoiceService`: begin / chunk / end / toSession / cancel. Clip < 1.5 s, silence (RMS < 0.0015) or no words → `{empty:true}`. The WAV lives in the OS temp dir with mode 0600 and is deleted right after transcription unless `keepAudio`. Ten-minute cap. One transcription at a time. |
| `screenshot.ts` | `ScreenshotService`: `/usr/sbin/screencapture -i -x -t png` (Esc → no file → `{cancelled:true}`) or an existing image → `openkt-ocr` → `/usr/bin/sips -s format png -Z 1280` → `describe_image` **with the OCR text** → turns exactly as Spec 03 §4 → `extract` → the two drop rules. |
| `permissions.ts` | Browser-permission policy: the app's own pages may open the **microphone** (the overlay records with `getUserMedia`); camera, screen capture and every other permission stay denied, for every origin. |
| `pipeline.ts` | Builds both services on top of `LocalAi`. Shared by the app (`ipc.ts`) and the CI proof (`scripts/smoke-capture.mjs`). |
| `ipc.ts` | Electron wiring: `systemPreferences.askForMediaAccess('microphone')`, Screen Recording status, hiding OpenKT's floating overlays while the region picker is up. |
| `../../../native/ocr/main.swift` | `openkt-ocr <image> [--languages en-US,th-TH]` — Apple Vision `VNRecognizeTextRequest`, `.accurate`, language correction, automatic language detection. Prints `{"text","lines":[{"text","x","y","w","h","confidence"}]}` (boxes are 0..1 fractions, origin top-left); on failure a JSON `{"error"}` and exit 2 (usage) / 3 (unreadable image) / 4 (Vision). |

Binaries: `whisper-cli` is built in CI from the whisper.cpp tag pinned in `models.manifest.json` (`scripts/build-whisper.sh`:
static, Metal, shader library embedded, deployment target 13.3) → `Contents/Resources/whisper/`. `openkt-ocr` is compiled in CI
(`scripts/build-ocr.sh`) → `Contents/Resources/ocr/`. Both need a Mac to build; there is no Linux build of either.

### Renderer API

```ts
// ── voice ── the renderer owns the microphone; main owns everything after it.
const id = await window.openkt.voice.begin();
// → "uuid"  |  { error: 'permission_denied', message }   (macOS refused the microphone; nothing was started)
await window.openkt.voice.chunk(id, arrayBuffer /* 16 kHz mono PCM16, any size */);   // → { ok, duration_ms }
const r = await window.openkt.voice.end(id, { language: 'auto', keepAudio: false });
// → { text, raw_text, segments: [{ t0_ms, t1_ms, text }], language: 'en'|'th'|'hi'|…, duration_ms, transcribe_ms, used_gpu, audio_path? }
// → { empty: true, duration_ms, reason: 'too_short'|'silence'|'no_speech' }          nothing to save
// → { error: 'not_ready' | 'failed' | 'unknown_id', message }                        not_ready = whisper model still downloading
const note = await window.openkt.voice.toSession(id);   // once, after end → { title, summary, facts: [{ kind, statement, quote }], status }
await window.openkt.voice.cancel(id);                    // discard: drops audio and transcript

// ── screenshot ──
const s = await window.openkt.screenshot.capture({ mode: 'interactive' });          // or { mode: 'file', path, caption? }
// → { cancelled: true }                                          Esc in the picker
// → { nothing_to_save: true, nothing: true, … }                  generic description AND < 20 characters of text
// → { image_path, visible_text, description, entities, facts, title,
//     vision: 'ok'|'unavailable'|'failed', ocr_chars, dropped_facts: [{ statement, reason }], latency_ms: { ocr, resize, describe, extract }, notes }
// → { error: 'permission_denied', message }                      Screen Recording is switched off for OpenKT
const path = window.openkt.screenshot.pathForFile(file);          // a dropped File → its path ('' if it has none)
```

`vision: 'unavailable'` means the projector (mmproj) has not finished downloading: OCR + `extract` still run and the description is
empty. A fact is dropped (and listed in `dropped_facts`) when any number in its statement or quote is not in the OCR text.

### Hotkeys

Electron `globalShortcut`: **Control+Option+Space** opens the voice overlay; pressed again it sends the overlay a
`capture:event` `{type:'voice.final'}` — the toggle the overlay listens for (stop, then save). **Control+Option+S** opens the
screenshot overlay, which calls `screenshot.capture({mode:'interactive'})`. The `fn` key (hold to talk, double-tap to latch) needs a
native event tap and is out of scope for the interim runtime. The stub engine (`../engine/stub.ts`) now only simulates meetings.

## Environment switches

`OPENKT_MODELS_DIR`, `OPENKT_LLAMA_DIR`, `OPENKT_WHISPER_DIR`, `OPENKT_OCR_DIR`, `OPENKT_MODEL_TIER`, `OPENKT_WHISPER_MODEL`,
`OPENKT_NO_AUTO_MODELS=1`,
`OPENKT_SMOKE=1` (+ `OPENKT_SMOKE_OUT`, `OPENKT_SMOKE_OCR_IMAGE`) — the packaged-app self test CI runs: embeddings through the
bundled `llama-server`, `whisper-cli --help`, and `openkt-ocr` on an image.

## Not done yet

No streaming transcription (no partial text while speaking) and no voice-activity detection beyond the silence check. No `fn`
hotkey. Meetings are still the stub. No UI for choosing a models directory, the speech language, or deleting models. The
Developer-ID-signed (hardened runtime) build has not been exercised with the three helper binaries.
