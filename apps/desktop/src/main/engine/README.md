# Engine seam

The capture engine is a signed Swift helper that will ship inside the app
bundle (`docs/architecture.md` §5): global hotkeys including the bare `fn`
key, microphone and system-audio capture, and local inference through
`mlx-swift-lm` and `speech-swift`. **It does not exist yet.** This directory is
the seam it plugs into.

| File | Role |
|---|---|
| `protocol.ts` | Message types and the `Engine` interface. The contract. |
| `stub.ts` | `StubEngine`: simulates results with canned text. What runs today. |
| *(planned)* `swift.ts` | `SwiftEngine`: spawns the helper and speaks the protocol. |

`src/main/capture` depends only on the `Engine` interface, so replacing the
stub is a one-line change in `src/main/index.ts`.

## Planned transport

1. **stdio, newline-delimited JSON** (first implementation). Main spawns
   `Contents/Helpers/openkt-engine` with `stdio: ['pipe','pipe','inherit']`.
   One JSON object per line, UTF-8. stderr is the engine's log.
2. **XPC** (later, if the helper must outlive the app or hold entitlements the
   app should not): the same message objects, carried as XPC dictionaries by a
   thin native node module. Message shapes do not change.

## Lifecycle

```
main → engine   {"id":1,"method":"hello","params":{"protocol":1}}
engine → main   {"id":1,"ok":true,"result":{"engineVersion":"0.4.0"}}
engine → main   {"event":"ready","protocol":1,"engineVersion":"0.4.0"}
```

- Requests carry a numeric `id`; exactly one response echoes it
  (`ok:true,result` or `ok:false,error{code,message}`). Events carry no `id`.
- Unknown methods → `error.code = "unknown_method"`. Unknown events are ignored
  by main. A protocol mismatch in `hello` is fatal and surfaced in Settings.
- If the helper exits, main restarts it with backoff (1 s, 2 s, 4 s … 30 s) and
  fails any in-flight request with `engine_exited`.

## Hold-to-talk

Electron's `globalShortcut` has no key-up and cannot see `fn`, so the engine
owns the hotkeys and reports them:

```
engine → main   {"event":"hotkey","key":"voice.down"}
main → engine   {"id":7,"method":"voice.start","params":{"latch":false}}
engine → main   {"event":"voice.partial","captureId":"v1","text":"What if every","tentative":"new store","elapsedSec":1}
engine → main   {"event":"hotkey","key":"voice.up"}
main → engine   {"id":8,"method":"voice.stop","params":{}}
engine → main   {"event":"voice.final","captureId":"v1","text":"…","durationSec":14,"language":"en"}
```

Double-tap `fn` sends `voice.latch`; main starts with `latch:true` and stops on
the next tap. Until the engine exists, `src/main/shortcuts.ts` registers
toggle-style fallback accelerators instead.

## Privacy rules the engine must keep

- Raw audio and unshared screenshots never leave the machine; the engine hands
  main text, descriptions and a local file path only.
- Meeting capture never starts without `meeting.record {accept:true}`.
