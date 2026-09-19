# Connect OpenKT in Claude Code

Status: **verified** against https://code.claude.com/docs/en/mcp, /skills and /plugins-reference on 2026-09-19.

## Easiest: the plugin (server + skill + commands + optional hooks)

```bash
claude plugin marketplace add masti-ai/openkt     # the OpenKT repository; use your fork or mirror if different
claude plugin install openkt@openkt
```

Self-hosted server: add `--config server_url=https://kt.example.com/mcp` to the install command. Then start `claude`, run `/mcp`, choose **openkt**, and sign in in the browser.

## Server only

```bash
claude mcp add --transport http --scope user openkt https://mcp.openkt.ai/mcp
```

- `--scope user` makes it available in every project. Omit it for this project only (stored in `~/.claude.json`), or use `--scope project` to write a shared `.mcp.json` the team can commit:

```json
{ "mcpServers": { "openkt": { "type": "http", "url": "https://mcp.openkt.ai/mcp" } } }
```

  `"type": "http"` is required; an entry with a `url` and no `type` is rejected.
- Sign in: run `/mcp` inside Claude Code, pick **openkt**, follow the browser login. `claude mcp list` shows `Needs authentication` until then. From a shell, `claude mcp login openkt` does the same (v2.1.186+).

## The skill without the plugin

Copy this skill's folder to `~/.claude/skills/openkt/` (all projects) or `.claude/skills/openkt/` (one repository). The folder name must stay `openkt`.

## Check

`/mcp` lists **openkt** as connected and shows the `kt_` tools. Then run the round trip in [verify.md](verify.md).

Note: Claude Code does not render OpenKT's cards (it is a terminal). Where the server needs a choice, such as the space, it asks through a form prompt instead.
