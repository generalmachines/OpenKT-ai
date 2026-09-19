# packages/connect: design

OpenKT is used by agents. Connecting a tool therefore has to work on a headless machine with no desktop app, from a shell, with JSON in and out, and the app's "tick to connect" is one more caller of the same package.

## What the old system did, and what carries over

| Old (openkt-plugins, openkt-cli `internal/wire`) | Now |
|---|---|
| Claude Code plugin with Python hooks: `kt prime` on SessionStart, `recall.py` + `capture.py` on UserPromptSubmit, `sync_native_memory.py` on PostToolUse(Write\|Edit), `pre_compact.py`, `session_end.py`. Needed Python 3 and the Go `kt` binary. | One POSIX sh script with the same events (prime → brief, recall → context, native memory sync, session end), plus assistant turns from `Stop.last_assistant_message`. No Python, no Node, no binary: sh + curl. |
| Hooks patched into `~/.claude/settings.json`, reaping stale OpenKT entries by script name. | Same merge rule (OpenKT entries recognised by command, old `kt prime` and `~/.openkt/hooks/*.py` entries replaced), but format-preserving and reversible byte for byte. |
| `claude mcp add` / `~/.cursor/mcp.json` / `~/.codex/config.toml` / OpenCode entries pointing at the remote URL with `Authorization: Bearer ${env:OPENKT_TOKEN}`, and a patched shell rc to export the token. GUI apps never saw the variable. | A local stdio MCP command (the same script) that reads the token from the shared credentials store. No token or env var in any config; works in GUI apps. |
| `sync_native_memory.py` mirrored `~/.claude/projects/*/memory/*.md` into the project from `.openkt/manifest.json`, skipped outside `kt init` repos. | Same files, one fact per file tagged `native-memory`, replaced when the file changes, filed by folder mapping, else the personal space. Gemini CLI's `save_memory` facts too. |
| Codex plugin gated behind `[features] plugin_hooks` and `/hooks` trust. | `~/.codex/hooks.json` (hooks are on by default in current Codex); the person still approves them once in `/hooks`, which the status says. |
| `kt init` wrote `.openkt/manifest.json` per repo; without it nothing was scoped. | Manifest still honoured; otherwise `~/.openkt/folders.json`, created on demand, unknown repos noted and offered in the app. |

## Decisions

1. **Plain Node package, no Electron.** `packages/connect` exports the installers (`detect/status/plan/apply/undo/capabilities`), `runHook`, the credentials store and folder mapping. The app bundles it (esbuild, from source) and calls it over IPC; `bin/openkt-connect.mjs` exposes it to shells until `kt connect` (packages/cli) wraps it.
2. **Hooks talk to the server directly.** No local bridge process: the script reads the shared credentials store and calls the REST routes that exist today (sessions, turns, close, prime, recall, memories).
3. **MCP through a local stdio command, not OAuth, for tools on the machine.** Checked 2026-09-19: `https://mcp.openkt.ai/mcp` answers 401 without a token and accepts an `okt_pat_…` bearer; `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` exist with dynamic client registration, but `/oauth/authorize` redirects to `http://localhost:3000/oauth/authorize` (`OPENKT_DASHBOARD_URL` unset), so no browser sign-in can finish. PR #73 (server-rendered consent page) is merged but not deployed. The stdio command needs neither OAuth nor a token in config, and one sign-in covers every tool. claude.ai and ChatGPT can only use OAuth: their card says it is blocked until the consent page is live (checked live by `oauthConsentReachable`), and a connection is detected from a new `oauth:*` token in `GET /v1/me/tokens`. (`GET /v1/me/connectors` is not used: it mints a new access token on every call.)
4. **Edits are text edits.** A small JSONC editor (`jsonc.ts`) and marker blocks for TOML keep every unrelated byte; parse failures are reported, never overwritten.

## Depth per tool

| Tool | Installs | Saves sessions | Recall | Own memory | Docs checked |
|---|---|---|---|---|---|
| Claude Code | `~/.claude.json` mcpServers, 5 hooks in `~/.claude/settings.json`, skill in `~/.claude/skills/openkt/` | yes | every prompt | memory files | code.claude.com/docs/en/{hooks,mcp,skills,memory} |
| Codex | `[mcp_servers.openkt]` block in `~/.codex/config.toml`, `~/.codex/hooks.json` | yes, after `/hooks` approval | every prompt | no | learn.chatgpt.com/docs/{extend/mcp,hooks} |
| Cursor | `~/.cursor/mcp.json`, `~/.cursor/hooks.json` | yes | session start only (beforeSubmitPrompt cannot add context) | no | cursor.com/docs/{context/mcp,agent/hooks} |
| Gemini CLI | `~/.gemini/settings.json` mcpServers + hooks | yes | every prompt (BeforeAgent) | `save_memory` facts | geminicli.com/docs/{tools/mcp-server,hooks/reference} |
| Claude Desktop | `claude_desktop_config.json` stdio server | no (no hooks) | tools only | no | modelcontextprotocol.io/docs/develop/connect-local-servers |
| VS Code Copilot | user `mcp.json` `servers.openkt` | via Claude Code's hooks (Copilot reads `~/.claude/settings.json`) | tools only | no | code.visualstudio.com/docs/copilot/customization/{mcp-servers,hooks} |
| Windsurf (Cascade) | `mcp_config.json`, `hooks.json` | yes | tools only (hooks cannot add context) | no | docs.devin.ai/desktop/cascade/{mcp,hooks} |
| OpenCode | `opencode.json` `mcp.openkt` (local) | no (plugins only) | tools only | no | opencode.ai/docs/{mcp-servers,config,plugins} |
| claude.ai, ChatGPT | nothing on disk: guided card | no | tools only | no | claude.com/docs/connectors/custom/remote-mcp, developers.openai.com/api/docs/guides/developer-mode |
| Any agent | the hook script; `{"context_md"}` dialect | yes | every call | no | Spec 06 |

## A server endpoint that would simplify the script

The script keeps a per-session id map and formats recall results with awk because today's routes need three calls and client-side formatting. Proposed, for the maintainers (not built here):

`POST /v1/hooks/{session-start|prompt|turn|session-end}` with `{client, client_session_id, cwd?, project_id?, prompt? | content?, role?, budget_chars?}` → `{session_id, context_md}`. The server finds or creates the session by `(owner, client, client_session_id)` (Spec 04's `external_id`, which `CreateSessionSchema` does not accept yet), appends the turn, runs recall with the budget and returns markdown with authors. The script would shrink to one curl per event. Also: `SessionSourceSchema` has no `codex`, `cursor`, `gemini`, `windsurf` values, so those sessions are `source: connector` with `client` naming the tool.

## Known gaps

- Codex hooks: the files match the current docs and Codex 0.131 loads the MCP entry (`codex mcp list`), but a `codex exec` on this machine without OpenAI credentials fired no hook even with `--dangerously-bypass-hook-trust`, so Codex capture is verified only against the fake server.
- `~/.claude.json` is also rewritten by a running Claude Code; an edit made while it runs could be overwritten (the status then shows the MCP part missing; tick again).
- The script's JSON handling (grep -o tokenizer + awk) is tested with GNU/busybox grep and gawk/mawk/busybox/BWK awk, not with macOS's BSD grep binary itself.
