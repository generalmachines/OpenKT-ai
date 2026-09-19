# Connect OpenKT in OpenAI Codex (CLI and IDE extension)

Status: **verified** on 2026-09-19 against OpenAI's Codex docs (developers.openai.com/codex/mcp, which now redirects to learn.chatgpt.com/docs/extend/mcp), the skills page, and `codex mcp add --help` / `codex mcp login` in codex-cli 0.131. The Codex app and IDE extension read the same `~/.codex/config.toml`. If `codex mcp add --url` is rejected, update Codex.

## Server

```bash
codex mcp add openkt --url https://mcp.openkt.ai/mcp
codex mcp login openkt        # opens the browser for OAuth
```

Equivalent entry in `~/.codex/config.toml` (or a project's `.codex/config.toml`):

```toml
[mcp_servers.openkt]
url = "https://mcp.openkt.ai/mcp"
```

## Skill

Copy the `openkt/` folder to `~/.agents/skills/openkt/` (all projects) or `.agents/skills/openkt/` in the repository. Codex no longer lists `~/.codex/skills`. Invoke explicitly with `$openkt`, or see it under `/skills`.

## Check

`codex mcp list` shows **openkt**; inside Codex, `/mcp` lists the `kt_` tools. Then run the round trip in [verify.md](verify.md).
