# Connect OpenKT in any other MCP client

Status: general guidance; **not verified** per client. Check the client's own MCP documentation and prefer it over this page.

What to enter, wherever the client asks for an MCP server:

| Field | Value |
|---|---|
| Name | `openkt` |
| Transport | Streamable HTTP (sometimes "HTTP" or "remote") |
| URL | `https://mcp.openkt.ai/mcp`, or your team's own server |
| Authentication | OAuth. Leave client ID and secret empty; the server registers the client itself |

The most common config shape, used by many clients (Windsurf, Cline, Roo, Goose, Amp, Kiro and others, each in its own file):

```json
{ "mcpServers": { "openkt": { "url": "https://mcp.openkt.ai/mcp" } } }
```

Some clients need `"type": "http"` (Claude Code, VS Code) or a different key (`httpUrl` in Gemini CLI, `serverUrl` in some others). If the client only supports local (stdio) servers, the `mcp-remote` npm package can bridge to a remote one: `"command": "npx", "args": ["-y", "mcp-remote", "https://mcp.openkt.ai/mcp"]`. That runs third-party code on the user's machine, so explain it and get a yes first.

**Skill.** Most tools that support the open Agent Skills format read `~/.agents/skills/<name>/` and `.agents/skills/<name>/`. Copy the `openkt/` folder there. If the client has no skills support, paste the body of `SKILL.md` into its custom instructions or rules file.

Never put a token in a config file or in the chat. If a client cannot do OAuth, stop and tell the user; do not improvise with a pasted credential.

Then run the round trip in [verify.md](verify.md).
