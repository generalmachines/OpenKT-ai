# Connect OpenKT in VS Code (GitHub Copilot agent mode)

Status: **verified** against https://code.visualstudio.com/docs/copilot/customization/mcp-servers and /agent-skills on 2026-09-19, with one gap: the docs do not say whether sign-in works without an `oauth` block. It should, through the server's dynamic registration; if VS Code asks for a client ID, that is the reason.

## Server

Command Palette → **MCP: Add Server** → **HTTP** → `https://mcp.openkt.ai/mcp` → name it `openkt` → choose *Global* or *Workspace*.

Or write `.vscode/mcp.json` (workspace), or use **MCP: Open User Configuration** (all workspaces). Note the top-level key is `servers`, not `mcpServers`:

```json
{ "servers": { "openkt": { "type": "http", "url": "https://mcp.openkt.ai/mcp" } } }
```

Start the server from the code lens in that file or from **MCP: List Servers**. VS Code asks whether you trust the server the first time, then opens the browser for sign-in.

## Skill

Copy the `openkt/` folder to `.github/skills/openkt/`, `.claude/skills/openkt/` or `.agents/skills/openkt/` in the repository, or to `~/.copilot/skills/openkt/`, `~/.claude/skills/openkt/` or `~/.agents/skills/openkt/` for all workspaces.

## Check

In Copilot Chat's agent mode, open the tools picker and confirm the `kt_` tools are ticked. Then run the round trip in [verify.md](verify.md). VS Code renders OpenKT's cards.
