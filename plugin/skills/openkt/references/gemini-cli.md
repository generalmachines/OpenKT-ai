# Connect OpenKT in Gemini CLI

Status: **verified** against https://geminicli.com/docs/tools/mcp-server/ and https://geminicli.com/docs/cli/skills/ on 2026-09-19.

## Server

```bash
gemini mcp add --transport http --scope user openkt https://mcp.openkt.ai/mcp
```

Without `--scope user` it is added to the current project only. Equivalent entry in `~/.gemini/settings.json` (or `.gemini/settings.json`); note the key is `httpUrl` — in Gemini CLI `url` means an SSE endpoint:

```json
{ "mcpServers": { "openkt": { "httpUrl": "https://mcp.openkt.ai/mcp" } } }
```

Sign-in is discovered automatically on first use: the CLI opens the browser. To trigger it yourself, run `/mcp auth openkt` inside Gemini CLI. Tokens are kept in `~/.gemini/mcp-oauth-tokens.json`.

## Skill

Copy the `openkt/` folder to `~/.gemini/skills/openkt/` or `~/.agents/skills/openkt/` (user), or `.gemini/skills/openkt/` or `.agents/skills/openkt/` (workspace). Or link a local copy from inside the CLI: `/skills link /path/to/openkt --scope user`, then `/skills reload`. `gemini skills list` shows it.

## Check

`/mcp` lists **openkt** and its `kt_` tools. Then run the round trip in [verify.md](verify.md).
