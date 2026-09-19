# Connect OpenKT in Cursor

Status: **verified** for config and skills against https://cursor.com/docs/context/mcp and https://cursor.com/docs/context/skills on 2026-09-19. The wording of the sign-in button was not on the page.

## Server

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project). Merge into the existing `mcpServers` object; do not replace the file.

```json
{ "mcpServers": { "openkt": { "url": "https://mcp.openkt.ai/mcp" } } }
```

Cursor uses no `type` field for remote servers. Open Cursor's MCP settings (**Customize** in the sidebar, or Settings → MCP), find **openkt**, enable it and complete the browser sign-in when prompted. With the Cursor CLI: `agent mcp login openkt`.

Self-hosters: Cursor's OAuth redirect is fixed at `http://localhost:8787/callback` (desktop) and `https://www.cursor.com/agents/mcp/oauth/callback` (web agents); the OpenKT server must accept both.

## Skill

Copy the `openkt/` folder to `~/.cursor/skills/openkt/` or `~/.agents/skills/openkt/` (all projects), or `.cursor/skills/openkt/` or `.agents/skills/openkt/` (this repository). Cursor also reads `.claude/skills/` and `~/.claude/skills/`, so one copy can serve both tools. The folder name must match the skill's `name`.

## Check

The MCP settings show **openkt** with its `kt_` tools enabled. Then run the round trip in [verify.md](verify.md).
