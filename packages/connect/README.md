# @openkt/connect

Connects the AI tools on a machine to OpenKT, one tick (or one command) per tool. It installs the OpenKT MCP server and, where the tool supports hooks, a hook script that saves each conversation as an OpenKT session and brings relevant context into prompts. It also mirrors a tool's own memory into OpenKT where it can.

Nothing here depends on the desktop app running. The app's tick UI, `openkt-connect`, and `kt connect` (packages/cli) all call the same functions.

## Use it

```sh
npm run build -w @openkt/connect
node packages/connect/bin/openkt-connect.mjs list --json               # every tool: detected, status, capabilities
node packages/connect/bin/openkt-connect.mjs auth login --email you@example.com --password-stdin
node packages/connect/bin/openkt-connect.mjs connect claude-code        # --dry-run lists the files; --undo puts them back
node packages/connect/bin/openkt-connect.mjs test claude-code           # a real session-start → prompt → end through the hooks
```

Output is JSON when `--json` is given or stdout is not a terminal. Errors are `{"error": {"code", "message", "hint"?}}` with the exit codes of Spec 06: 2 usage, 3 not signed in, 4 unknown tool or not installed, 5 conflict, 6 unreadable config, 7 network, 1 anything else.

| Command | Does |
|---|---|
| `list` | every tool with `detected`, `status` (`connected` · `partial` · `not-connected` · `needs-attention`), `reasons`, `capabilities` |
| `status [<tool>]` | the same plus whether this machine is signed in |
| `connect <tool> [--undo] [--dry-run] [--no-native-memory] [--force]` | apply or undo; the result lists every file changed |
| `guide <tool>` | the steps for tools set up in their own UI (`claude-ai`, `chatgpt`, `agent`) |
| `test [<tool>]` | fires the installed hook script like the tool would; returns the session it created |
| `hook <tool> <event>` | the hook core in Node (`runHook`), for agents that prefer it to the sh script |
| `folders` · `folders map <path> <space_id\|personal> [--name]` | which space a folder's sessions go to |
| `auth status\|login\|set --token-stdin\|logout` | the shared credentials store (below) |

Tool ids: `claude-code`, `codex`, `cursor`, `gemini`, `claude-desktop`, `vscode`, `windsurf`, `opencode`, `claude-ai`, `chatgpt`, `agent`.

From code: `listTools`, `planTool`, `connectTool`, `disconnectTool`, `guideTool`, `selfTest`, `runHook`, `readCredentials`, `writeCredentials`, `listFolders`, `mapFolder`, all taking a `ConnectEnv` (`systemEnv()` for the real machine, `homeEnv(dir)` for a sandbox).

## What a connect writes

Every write is a merge into the tool's own config: unrelated keys, comments and formatting stay byte for byte; the file is backed up beside itself first (`<file>.openkt-backup-<UTC stamp>`); a config that does not parse is never written and the tool reports `needs-attention` with the reason; applying twice changes nothing; undo restores the original byte for byte when the file has not changed since, and otherwise removes only OpenKT's entries. What was written is recorded in `~/.openkt/connect/state.json`.

**No tool config ever contains a token.** The MCP server is registered as a local stdio command, `/bin/sh ~/.openkt/hooks/openkt-hook.sh mcp`, which forwards each JSON-RPC message to `<server>/mcp` with the stored credentials. Hooks call the same script. Signing in or out changes every tool at once.

## Credentials

Shared by the kt CLI, the hook script and the desktop app (Spec 06 §2). Resolution order, identical in `credentials.ts` and the script's `okt_creds`:

| | server | token |
|---|---|---|
| 1 | `$OPENKT_SERVER` | `$OPENKT_TOKEN` |
| 2 | `~/.openkt/config.json` `server` | macOS keychain: service `openkt`, account `default` |
| 3 | `~/.openkt/credentials.json` `server` | `~/.openkt/credentials.json` `token` (mode 600) |
| 4 | `https://api.openkt.ai` | none: signed out |

For the desktop app (the follow-up in `src/api/auth.ts`, which this change does not touch): on every sign-in call `writeCredentials(systemEnv(), {server, token})`; on sign-out call `clearCredentials`. On macOS that runs `/usr/bin/security -i` with `add-generic-password -U -s openkt -a default -w <token>` on stdin (the token never appears in a process list). The item must be created by `/usr/bin/security` itself: then the hook script's `security find-generic-password` reads it without a keychain prompt. An item created through another API would make macOS ask, and a hook cannot wait for that. Until that wiring lands, the app stores its sign-in when a tool is ticked (`src/main/connect/ipc.ts`, `shareSignIn`).

## The hook script

`assets/openkt-hook.sh` (installed to `~/.openkt/hooks/openkt-hook.sh`, embedded in `src/assets.generated.ts` by `npm run embed`). POSIX sh, curl, awk, sed, grep: nothing a Mac or a Linux box lacks. Tested with dash and bash `--posix`, and with gawk, mawk, busybox and BWK awk.

```
openkt-hook.sh <tool> <event>     stdin: the tool's hook JSON        stdout: what that tool reads back
openkt-hook.sh mcp                stdio MCP server → <server>/mcp
openkt-hook.sh flush              send what the outbox holds
```

| event | server calls | stdout |
|---|---|---|
| `session-start` | `POST /v1/sessions` (in the background) + `POST /v1/prime {with_briefing}` | the brief (≤ 1,500 chars, with authors) and the session id, so the model passes it to `kt_recall` / `kt_save_memory` and does not start a second session |
| `prompt` | `POST /v1/sessions/:id/turns {role:user}` (background) + `POST /v1/memories/recall` (1.2 s budget) | recalled items above similarity 0.5, `- <fact> — <author>, <space>, <date>`, ≤ 1,500 chars; nothing when nothing is relevant |
| `stop` | `POST /v1/sessions/:id/turns {role:assistant}` (≤ 8 KB) | nothing |
| `session-end` | `POST /v1/sessions/:id/close` | nothing |
| `native-memory` | `POST /v1/memories {tag_slugs:[native-memory,…]}`; a changed file replaces its fact (`DELETE` the old one) | nothing |

Output dialects: Claude Code, Codex and VS Code `{"hookSpecificOutput":{"hookEventName":"SessionStart"|"UserPromptSubmit","additionalContext":…}}`; Gemini CLI the same with `BeforeAgent`; Cursor `{"additional_context":…}` at session start and `{"continue":true}` for prompts; `agent` `{"context_md":…}`.

Rules: every path exits 0; the tool never waits more than about 1.5 s (writes go out detached); writes that cannot be sent (offline, signed out, 5xx, 401, 429) wait in `~/.openkt/outbox/` (capped at 50 MB, oldest dropped) and are flushed in order by the next hook call; the token reaches curl through a 0600 file in a private run directory that is removed afterwards; `~/.openkt/logs/hook.log` records events and status codes, never prompt text.

State: `~/.openkt/state/sessions/<tool>__<client session id>` maps a tool's session to its OpenKT session; `~/.openkt/state/native/` remembers which memory files were synced.

## Spaces without `kt init`

A session's space comes from the nearest `.openkt/manifest.json` (below `$HOME`, the old `kt init` file), else from `~/.openkt/folders.json` (written by `mapFolder`, one folder per line so the script can grep it). A git repository with neither goes to the personal space and is noted in `~/.openkt/folders.pending`; the app lists those under Settings → Connectors → Folders ("Sessions from ~/code/acme are private to you. File them in a team space?").

## Environment

`OPENKT_HOME` (default `~/.openkt`), `OPENKT_SERVER`, `OPENKT_TOKEN`, `OPENKT_NO_KEYCHAIN=1`, `OPENKT_RECALL_TIMEOUT` (1.2), `OPENKT_MIN_SIMILARITY` (0.5), `CODEX_HOME`, `XDG_CONFIG_HOME`.

## Tests

`npm test -w @openkt/connect`: fixture configs per tool in a temporary home, the sh script against a fake server, the Node core, the CLI. The live test logs in to an existing account (it never signs up):

```sh
OPENKT_LIVE_EMAIL=… OPENKT_LIVE_PASSWORD=… npx vitest run test/live.test.ts     # OPENKT_LIVE_SERVER defaults to https://api.openkt.ai
OPENKT_TEST_SHELL=bash OPENKT_AWK=/path/to/other/awk npx vitest run test/hook-script.test.ts
```
