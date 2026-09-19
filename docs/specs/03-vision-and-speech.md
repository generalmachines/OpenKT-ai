# Spec 03 — vision, speech and how local reasoning works

> Owner: senior. Status: decided. Applies to the desktop engine (`apps/desktop/engine`, Swift) and to the server when it receives images.

## 1. The principle

A 4-billion-parameter model cannot be trusted with one big open question ("what matters in this meeting?"). It can be trusted with many small closed ones ("list statements in this 90-second window, with the exact words that support each"). So:

1. **Perception first, language second.** Audio becomes text; pixels become text plus a description. Only text goes on to extraction. There is exactly one extraction path, the `extract` agent from Spec 02, whatever the source.
2. **Deterministic tools before a model.** OCR before the vision model. Voice-activity detection before speech recognition. Channel separation before diarization.
3. **Thinking stays off.** Qwen3.5-4B loops when allowed to think and breaks its JSON. Every call is single-shot, schema-constrained, temperature 0. Hard inputs are handled by decomposing the task, never by turning thinking on.
4. **Everything the model claims must point at evidence** — a quote from the transcript, or text the OCR found. No evidence, no fact.

## 2. Models and where each runs

| Job | Model | Runtime | Loaded |
|---|---|---|---|
| Voice activity | Silero VAD | CoreML | always (tiny) |
| Dictation | Parakeet-EOU 120M streaming (English + 24 European languages) | CoreML, Neural Engine | on first hotkey press, kept 10 min |
| Dictation, other languages | Omnilingual ASR CTC 300M | MLX | when the user's language setting is outside Parakeet's list |
| Meetings | Omnilingual ASR CTC 300M (1B optional) | MLX | for the duration of a recording |
| Speakers | Sortformer 117M | CoreML | for the duration of a recording |
| Echo cancel | LocalVQE | CoreML | during meetings when mic and speakers are both live |
| Text + vision | Qwen3.5-4B 4-bit (Qwen3.5-2B on 8 GB Macs) | MLX, `mlx-swift-lm`, guided generation | on demand, kept 5 min after last use |
| Embeddings | Qwen3-Embedding-0.6B | MLX | on demand |
| Reranking | Qwen3-Reranker-0.6B | MLX | only for local search in the app |

Memory rule: never hold speech recognition for meetings **and** Qwen3.5-4B resident together on an 8 GB Mac — finish transcription, unload, then load the language model. On 16 GB+ they may coexist.

Every row is one `ModelProvider` with two implementations: **in-process MLX/CoreML** (default) and **remote OpenAI-compatible URL** (user's choice, per job). The embedding job is the exception: it may only be swapped for the same model id, because vectors must match the server's index (checked with the golden-vector test — 20 fixed strings, cosine ≥ 0.999 against the server's vectors; on failure the app stops embedding and lets the server do it).

## 3. Voice note (hold `fn`)

```
fn down ─► mic opens ─► VAD ─► streaming ASR ─► live text in the pill
fn up   ─► final pass on the whole clip (non-streaming decode, better punctuation)
        ─► cleanup (code): remove filler tokens from a fixed list, collapse repeats, keep everything else verbatim
        ─► one session {source:'voice'}, one turn {role:'user', content:<text>}
        ─► space = the pill's selection (default: connector default for 'voice')
        ─► `summarise` → title; `extract` → facts   (both local)
        ─► sync: turn text + facts. The audio file is deleted unless "keep audio" is on; it is never uploaded.
```

- Double-tap `fn` latches recording until the next tap; auto-stop after 10 minutes of speech or 20 s of silence.
- A clip under 1.5 s or with no speech detected creates nothing.
- The cleanup step is **code only**. A model never rewrites what the person said — the quote gate depends on the transcript being verbatim.

## 4. Screenshot or image

```
capture (region / window / dropped image file)
  ─► Apple Vision OCR                        → visible_text (with line boxes)          [always, ~100 ms]
  ─► `describe_image` (Qwen3.5-4B, image + visible_text + optional typed or spoken caption)
        → { description (≤ 60 words: what this is and why someone would save it),
            visible_text_key (the ≤ 400 chars of OCR text that matter),
            entities[] (people, companies, products, numbers with units) }
  ─► one session {source:'screenshot'|'image'}, turns:
        1. {role:'note', content: caption}                     (if the user gave one)
        2. {role:'note', content: description}
        3. {role:'note', content: 'Text in image: ' + visible_text_key}
  ─► `extract` over those turns                                → facts; quotes point into turn 2 or 3
```

Decisions:
- Image resized so the long edge is ≤ 1,280 px before the model sees it; the original is kept locally.
- **The vision model is given the OCR text.** It reads small text worse than OCR does; its job is meaning (what kind of screen, what the chart shows, what changed), not transcription.
- A fact may quote the description (turn 2) — that is how "the chart shows churn rising since March" becomes retrievable — but facts quoting only the description get confidence 0.50 (Spec 02 §8), and numbers must also appear in `visible_text` or they are dropped.
- If OCR finds < 20 characters and the description is generic ("a screenshot of a desktop"), nothing is saved and the sheet says so.
- The image itself uploads only when the user files the capture into a shared space **and** leaves "include image" on. Otherwise only the text syncs, and `attachments.storage_url` is null.

## 5. Meeting

```
detect: a known meeting app holds the mic (Zoom, Meet in a browser, Teams, Webex, Slack, FaceTime)
  ─► prompt "Keep this meeting as a session?"  [Record] [Not this one]      — never auto-record
record: two channels, never mixed
     mic            → "me"
     system audio   → "them"   (ScreenCaptureKit / Core Audio tap)
  ─► echo cancel on mic ─► VAD per channel ─► ASR per channel, 30 s windows with 2 s overlap
  ─► Sortformer on the system channel only → speaker_1..n
  ─► merge by timestamp → turns {role:'speaker', speaker:'me'|'speaker_2', t0_ms, t1_ms, content}
on stop:
  ─► name speakers (code): calendar attendees if calendar access was granted and the meeting has exactly
     two participants → the other name; otherwise leave speaker_n and let the user rename once in the app
  ─► chunk by time: 5-minute windows, cut at the nearest silence, 2-turn overlap           (Spec 02 §2)
  ─► `extract` per window  ─► `summarise` over the list of window summaries, not the raw transcript
  ─► session {source:'meeting'} lands in the app with summary, facts, transcript
  ─► sync per the 'meeting' connector default. Audio deleted after transcription unless "keep audio" is on.
```

Decisions:
- **Two channels are the diarization.** "Me" is never guessed by a model. Sortformer only separates the remote voices.
- Summaries of long meetings are hierarchical: each window yields ≤ 3 sentences; the final summary is written from those. A 4B model given a 60-minute transcript produces mush; given 12 short summaries it does fine.
- Transcript text is kept verbatim, including disfluencies, because quotes must match. The UI may hide fillers; storage does not.
- Languages: Omnilingual CTC has weak punctuation. A punctuation pass is **not** done by the language model (it would alter words). Use the CTC output as is; the `extract` prompt is told punctuation may be missing.
- Consent: a persistent "Recording" pill while recording; the prompt carries the line "tell the others you are recording"; a workspace setting can force a confirmation checkbox or disable meetings entirely. Nothing is recorded before the user presses Record.

## 6. Engine ↔ app protocol

The Swift engine is a helper binary inside the app bundle. Electron's main process starts it and talks **newline-delimited JSON over stdio**. Every message has `id`, `type`; replies echo `id`.

```
→ {"id":"1","type":"models.status"}                      ← {"id":"1","models":[{"job":"text","name":"qwen3.5-4b","state":"ready|downloading|absent","progress":0.62}]}
→ {"id":"2","type":"models.ensure","job":"text"}          ← progress events, then {"id":"2","ok":true}
→ {"id":"3","type":"voice.start"}                         ← {"event":"voice.partial","text":"what if every"} …
→ {"id":"4","type":"voice.stop"}                          ← {"id":"4","text":"…","duration_ms":14200}
→ {"id":"5","type":"screenshot.capture","mode":"region"}  ← {"id":"5","image_path":"…","visible_text":"…","boxes":[…]}
→ {"id":"6","type":"agent.run","agent":"extract","input":{…}}   ← {"id":"6","output":{…},"attempts":1,"latency_ms":840}
→ {"id":"7","type":"embed","texts":["…"],"kind":"document|query"} ← {"id":"7","vectors":[[…]]}
→ {"id":"8","type":"meeting.start"} / {"type":"meeting.stop"}     ← {"event":"meeting.turn",…} … then the full turn list
   {"event":"meeting.detected","app":"zoom.us"}            (unsolicited)
   {"event":"hotkey","name":"voice|voice_latch|screenshot"} (unsolicited)
```

`agent.run` loads prompts and schemas from the same files as `packages/agents` (`prompts/*.md`, `schemas/*.json`) copied into the app bundle at build time, so local and server extraction cannot drift. The Electron app never calls a model itself.

## 7. Latency budgets (M-series, 16 GB)

| Step | Budget |
|---|---|
| hotkey → pill visible and listening | 150 ms |
| speech → partial text | 300 ms |
| `fn` up → session visible in the app | 2 s for a 15 s note (final decode + summarise + extract) |
| screenshot → sheet with description | 3 s cold, 1.5 s warm |
| 60-min meeting → summary + facts | under 4 min after stop |

Missing a budget by more than 2× is a bug to be filed, not something to hide behind a spinner.
