# Spec 06 — The agent interface (CLI + JSON)

> Owner: maintainers. Status: decided 2026-09-19. Read with Spec 04 (the REST + MCP contract this builds on).

**OpenKT is a product for agents.** The people are the ones whose context it is; the users of the product are their AI agents — coding sessions, personal agents, browser agents, scripts. So every capability is reachable in the three ways an agent can call things, and all three say the same thing:

| Surface | For | Where |
|---|---|---|
| **REST** (`/v1/*`, JSON) | anything that can make an HTTP call | Spec 04 |
| **MCP** (`/mcp`) | agents inside an MCP client (Claude, ChatGPT, Cursor, Codex…) | Spec 04 |
| **CLI** (`kt`) | agents with a shell — the cheapest, most reliable surface there is | this spec |

The desktop app is **one client** of the same API: a place for people to see and manage their context. It is never the only way to do something, and nothing an agent needs depends on it running.

## 1. Rules every surface follows

1. **JSON in, JSON out.** Every command, tool and endpoint takes and returns JSON with the field names from Spec 04 (snake_case). No output an agent has to scrape.
2. **One operation, three names.** An operation has one id (`context.recall`) that maps to one REST route, one MCP tool and one CLI command. The table in §4 is the registry. A capability missing from any column is a bug unless the column says why.
3. **Self-describing.** `kt help --json` lists every command with its input JSON Schema and one example; `GET /v1/openapi.json` describes REST; MCP `tools/list` describes MCP; `GET /llms.txt` (≤ 4 KB) tells an agent what OpenKT is and which of the three to use.
4. **Errors an agent can act on.** Always `{"error": {"code", "message", "hint"?}}` with the codes from Spec 04. `hint` says the next command to run (`"run: kt auth login"`).
5. **Budgeted output.** Anything that returns context accepts a character budget (`--budget`, `budget_chars`) and returns `context_md` already fitted to it, so an agent can paste it without counting tokens.
6. **Never interactive by accident.** No prompts when stdin is not a TTY or `--json` is set. Destructive commands need `--yes` when non-interactive.
7. **Idempotent writes.** Writes accept an idempotency key (`--idempotency-key`, header `Idempotency-Key`); repeating a call with the same key returns the first result. (Server support: v0.2. Until then the CLI sends it and the server ignores it.)

## 2. The `kt` CLI

```
kt <noun> <verb> [args] [--flags]
```

**Output.** JSON when stdout is not a TTY or `--json` is given; a short human view otherwise. On success stdout is exactly the operation's `data` (not the `{data,error,meta}` envelope). On failure stdout is `{"error": {…}}` and the exit code says what kind:

| exit | meaning | error codes |
|---|---|---|
| 0 | ok | |
| 1 | anything else | `internal`, unknown |
| 2 | bad usage (unknown flag, missing argument) | `usage` |
| 3 | not signed in, token expired or revoked | `unauthorized`, `insufficient_scope` |
| 4 | not found — includes "you may not read it" (Spec 04: 404, not 403) | `not_found` |
| 5 | conflict | `version_conflict`, `email_taken`, closed session |
| 6 | invalid input | `invalid`, `weak_password`, `invalid_frontmatter`, … |
| 7 | server unreachable or 5xx | `network`, `server` |
| 8 | rate limited | `rate_limited` |

**Input.** Flags for the common fields; `--input <file|->` takes the whole request body as JSON (stdin with `-`), validated against the same schema `kt help --json` prints. `--fields a,b.c` trims the output. Lists take `--limit` and `--cursor` and return `{items, next_cursor}`.

**Server and credentials.** Resolution order: `--server` / `--token` flags → `OPENKT_SERVER` / `OPENKT_TOKEN` env → the credentials store → default server `https://api.openkt.ai`. The credentials store is shared by the CLI, the hook script (`packages/connect`) and the desktop app:
- macOS: keychain item service `openkt`, account `default` (`security find-generic-password -s openkt -a default -w`), value = the token; the server URL in `~/.openkt/config.json`.
- elsewhere or when the keychain is unavailable: `~/.openkt/credentials.json`, mode 600, `{server, token}`.

A token never appears in any tool's config file, in logs, or in `kt` output other than `kt auth token`.

**Signing in.**
- `kt auth login` — device code (headless-friendly; the server already has `/v1/auth/device-code`): prints `{verification_uri, user_code, expires_in}` and waits until approved. With `--json`, prints that object first, then the session on approval.
- `kt auth login --email you@x.com --password-stdin` — for scripts.
- `kt auth signup --email --name --password-stdin`
- `kt auth login --token okt_pat_…` — store a token made elsewhere.
- `kt auth status` → `{signed_in, server, user, expires_at}` · `kt auth token` · `kt auth logout`

## 3. The agent loop

What an agent does in a working session, in CLI form (the MCP tools in Spec 04 are the same calls):

```sh
S=$(kt session start --title "Fix checkout bug" --space acme --json | jq -r .session_id)   # returns brief_md too
kt recall "how do we handle refunds for annual plans" --session "$S" --budget 1500 --json  # → {items, context_md, recall_id}
kt save "Refunds for annual plans are pro-rated by month; decided by Ana 2026-09-12" --kind decision --session "$S"
kt session end "$S" --summary "Found the pro-rating bug in refund.ts; fixed and saved the rule."
```

## 4. Registry (v0.1 — what exists or lands next)

| Operation | REST (Spec 04) | MCP tool | CLI |
|---|---|---|---|
| auth.* | `/v1/auth/*`, `/v1/me` | — (MCP uses OAuth / bearer) | `kt auth login\|signup\|status\|token\|logout` |
| session.start | `POST /v1/sessions` | `kt_session_start` | `kt session start` |
| session.append | `POST /v1/sessions/:id/turns` | — (harnesses use hooks) | `kt session append <id> --role --content` / `--input -` |
| session.end | `POST /v1/sessions/:id/close` | `kt_session_end` | `kt session end <id>` |
| session.list / show | `GET /v1/sessions[/:id]` | — | `kt session list\|show` |
| context.save | `POST /v1/memories` | `kt_save_memory` | `kt save <text>` |
| context.recall | `POST /v1/memories/recall` | `kt_recall` | `kt recall <query>` |
| context.search | `POST /v1/memories/search` | `kt_search_memories` | `kt search <query>` |
| context.forget | `DELETE /v1/memories/:id` | `kt_forget_memory` | `kt forget <id> --yes` |
| context.feedback | `POST /v1/recall/:id/feedback` | `kt_feedback` | `kt recall feedback <recall_id> --used a,b` |
| space.list / create / show | `/v1/projects` | `kt_list_projects` | `kt space list\|create\|show` |
| space.brief | `GET /v1/projects/:id/brief` | `kt_project_brief` | `kt space brief <space>` |
| access.* | `/v1/{projects,sessions,skills}/:id/grants` | — (people decide access, not agents; read-only listing only) | `kt share <space\|session\|skill> <id> --email --role` · `kt access list <type> <id>` |
| skill.* | `/v1/skills*` (Spec 04 Skills) | `kt_list_skills`, `kt_get_skill`, `kt_save_skill` | `kt skill list\|get\|save\|run` |
| connect.* | — (local) | — | `kt connect <tool> [--undo]` · `kt connect list` (from `packages/connect`) |
| hook.* | via session/recall routes | — | `kt hook <event>` (reads the harness's hook JSON on stdin, writes the harness's expected JSON) |
| doctor | `GET /v1/meta`, `/healthz` | — | `kt doctor` → `{server, signed_in, connected_tools, problems:[…]}` |

Pages, briefs, attachments and connectors join the table as they land (Spec 04 §Spaces, Spec 05).

## 5. Packages

- **`packages/sdk`** — the typed client: zero runtime dependencies, `fetch`-based, Node ≥ 20 and browsers. One method per operation, typed from Spec 04 shapes, `ApiError {code, status, message, hint}`. The CLI uses it; the desktop app's `http` adapter and `packages/mcp-cards` move onto it later.
- **`packages/cli`** — `kt`. Built with esbuild into one file `dist/kt.mjs` (Node ≥ 20, no install-time dependencies). Command table generated from a single `commands.ts` registry (name, operation id, flags, input schema, example) that also produces `kt help --json`. Published as `@openkt/cli` (bin `kt`). A standalone binary (no Node) and `curl -fsSL https://openkt.ai/install.sh | sh` come after v0.1.
- The old Go `kt` (repo openkt-cli) is legacy; the new CLI replaces it and keeps its best idea — wiring tools — through `packages/connect`.

## 6. Acceptance

An agent holding nothing but `kt` and an email address can, with `--json` everywhere and no human prompt: sign up, create a space, start a session, save three facts, recall one of them with the budget honoured, share the space with a second account by email, and — as that second account — recall the fact and see who said it. `packages/cli/test/live-journey.sh` does exactly this against `OPENKT_SERVER` (default production) with throwaway `@e2e.openkt.test` accounts, and CI runs it on every pull request that touches `packages/cli`, `packages/sdk` or `server/`.
