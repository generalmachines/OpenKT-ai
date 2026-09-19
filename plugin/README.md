# OpenKT for your AI tools

OpenKT is a remote MCP server. Everything works with only that connection; each layer on top makes it work better and asks less of you. Pick the level that fits the tool.

> **Status.** `https://mcp.openkt.ai/mcp` is the hosted service; sign-in is the server's own OAuth page (email and password, or create an account). The plugin, the skill and the setup prompt pass `claude plugin validate --strict` and were checked against each tool's current documentation. If you run your own server, use its `/mcp` URL wherever this folder says that address (see [`../server/README.md`](../server/README.md)).

| Level | What you add | What you get | Where it works |
|---|---|---|---|
| **1 · MCP only** | the server URL | All `kt_` tools. The server's own instructions tell the model when to start a session, recall, save and end. Cards for saving and search results in clients that render MCP Apps. | Any MCP client: claude.ai, Claude Desktop and mobile, ChatGPT, Claude Code, Cursor, Codex, VS Code, Gemini CLI, … |
| **2 · + skill** | the `skills/openkt` folder | The model follows the contract far more reliably: what is worth saving, how to phrase it, which space to use, what never to save, and how to connect OpenKT when it is missing. | Any tool that reads Agent Skills (`SKILL.md`): Claude, Codex, Cursor, VS Code Copilot, Gemini CLI and others |
| **3 · + plugin** | one install command | Levels 1 and 2 in one step, plus `/openkt:kt-recall`, `/openkt:kt-save`, `/openkt:kt-session-end`, `/openkt:kt-setup`, and optional hooks. | Claude Code (and Cowork, which loads Claude plugins) |

Hooks are a convenience at level 3. Nothing depends on them.

The fastest route for a person: paste [`SETUP-PROMPT.md`](SETUP-PROMPT.md) into their AI tool (Claude, ChatGPT, Codex, Claude Code, Cursor, a browser agent). It works out the client, connects the server, walks through the browser sign-in, states the contract the assistant follows from then on, and proves the connection with `kt_session_start`. It asks before changing any file and never handles credentials.

## Level 1 — connect the server

Server URL: `https://mcp.openkt.ai/mcp`. Self-hosted: your own `/mcp` endpoint. Sign-in is OAuth in the browser; there is no token to paste.

```bash
claude mcp add --transport http --scope user openkt https://mcp.openkt.ai/mcp    # Claude Code, then /mcp to sign in
codex mcp add openkt --url https://mcp.openkt.ai/mcp && codex mcp login openkt   # Codex
gemini mcp add --transport http --scope user openkt https://mcp.openkt.ai/mcp    # Gemini CLI, then /mcp auth openkt
```

claude.ai / Claude Desktop / Cowork: Customize → Connectors → **+** → Add custom connector. ChatGPT: enable Developer mode, then create the connection at chatgpt.com/plugins. Cursor: `"openkt": { "url": "…" }` in `~/.cursor/mcp.json`. VS Code: `MCP: Add Server` → HTTP. Exact steps, config snippets and what was verified for each client are in [`skills/openkt/references/`](skills/openkt/references/).

## Level 2 — add the skill

Copy `skills/openkt/` (keep the folder name) to where your tool reads skills:

| Tool | Personal | Per repository |
|---|---|---|
| Claude Code | `~/.claude/skills/openkt/` | `.claude/skills/openkt/` |
| Cursor, Codex, VS Code, Gemini CLI | `~/.agents/skills/openkt/` | `.agents/skills/openkt/` |
| claude.ai / Claude Desktop | zip the folder → Customize → Skills → Upload a skill | — |

A team can commit the folder to a repository (`.claude/skills/openkt/` and `.agents/skills/openkt/`) so every teammate's tool picks it up with no install at all. The skill is plain Markdown in the open [Agent Skills](https://agentskills.io) format, uses only the six standard frontmatter keys, and contains no scripts.

## Level 3 — the Claude plugin

```bash
claude plugin marketplace add masti-ai/OpenKT-ai      # this repository is the marketplace
claude plugin install openkt@openkt
```

(Inside Claude Code: `/plugin marketplace add masti-ai/OpenKT-ai`, then `/plugin install openkt@openkt`.) Then run `/mcp`, choose **openkt**, and sign in. From a local checkout: `claude plugin marketplace add ./plugin` (or the repository root) works the same way, and `claude --plugin-dir ./plugin` loads it for one session. The plugin connects the hosted server; self-hosters add their own URL with `claude mcp add`.

**Cowork** reads the same marketplace: Customize → Plugins → Add marketplace → `masti-ai/OpenKT-ai` → install OpenKT. For a manual upload, `scripts/build-plugin-zip.sh` writes `dist/openkt-plugin.zip` (this folder's contents, manifest at the zip root): Customize → Plugins → upload, or Organization settings → Plugins → Add plugins → Upload a file.

What is inside:

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Manifest (name `openkt`). |
| `.claude-plugin/marketplace.json` | Makes `plugin/` a marketplace. The repository root has a twin that points at `./plugin`, so `marketplace add <owner>/<repo>` works. |
| `.mcp.json` | The remote server: `{"type": "http", "url": "https://mcp.openkt.ai/mcp"}`. No local process, no token; sign-in is OAuth in the browser. |
| `skills/openkt/` | The skill, with per-client setup guides under `references/`. |
| `commands/` | `kt-recall`, `kt-save`, `kt-session-end`, `kt-setup`. Plugin commands are namespaced, so they appear as `/openkt:kt-recall` and so on; typing `/kt-` finds them. |
| `hooks/` | Optional hooks, below. |

### The optional hooks, and why they use a small script

The plan was hooks of type `http` or `mcp_tool` so that nothing runs locally. The current Claude Code hook reference rules that out where it matters:

- `SessionStart` supports only `command` and `mcp_tool` hooks, not `http`; and at launch `mcp_tool` hooks are **skipped**, because MCP servers are not connected yet (they run only on the `SessionStart` that follows `/clear` or compaction). The docs say to use a `command` hook for anything needed from the first turn.
- A `SessionEnd` `mcp_tool` hook can only fill its `input` from the hook's own JSON, which carries Claude Code's session id. `kt_session_end` needs the OpenKT `session_id`, which only the model holds. It also never triggers sign-in, so it fails silently when the server is not authenticated.

So `hooks/hooks.json` uses one dependency-free Node script, `hooks/openkt-hook.mjs` (about 60 lines, no network, no credentials, always exits 0):

| Event | What it does |
|---|---|
| `SessionStart` | Adds one line of context: open an OpenKT session now. After compaction or `--resume` it instead re-injects the OpenKT `session_id` this conversation already has, so the session survives context loss. |
| `PostToolUse` on `kt_session_start` / `kt_session_end` | Remembers, or clears, that `session_id` under the plugin's data directory. |
| `SessionEnd` | Housekeeping only. Closing the session stays with the model (`/openkt:kt-session-end`) and with the server, which closes idle sessions itself. |

`hooks/examples/session-end.mcp_tool.json` is the script-free `SessionEnd` hook, ready for the day `kt_session_start` / `kt_session_end` accept a `client_session_id`. It is not enabled. To run without any hooks, delete `hooks/hooks.json` or disable the plugin's hooks in `/hooks`; nothing else changes. Node is required only for the hooks.

## Names and addresses

- `masti-ai/OpenKT-ai` is the repository and the plugin marketplace; it appears in this file, `SETUP-PROMPT.md`, `skills/openkt/references/claude-code.md` and the server's `kt_setup` text. To try an unmerged change, install from a local checkout: `claude plugin marketplace add ./plugin`.
- `https://mcp.openkt.ai/mcp` is the hosted server, written in `.mcp.json`, the skill, the setup prompt and `kt_setup`. (There is no plugin option for it: a URL placeholder that a client does not fill in would break the connector.)
- Validate with `claude plugin validate plugin/.claude-plugin/plugin.json --strict`, `claude plugin validate plugin --strict` and `claude plugin validate . --strict` (the root marketplace).
