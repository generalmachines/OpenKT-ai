// GET /connect and GET /llms.txt — plain Markdown an AI agent reads and
// follows to connect OpenKT (no UI; the page for people is /connect.html).
// Says the same things as plugin/SETUP-PROMPT.md and the kt_setup tool.

export const ONE_LINE_SETUP = (mcpUrl: string) => `Add this MCP server: ${mcpUrl} — it signs you in by itself.`;

// The line people paste into their AI tool (the join page shows it too).
export const ONE_LINE_PROMPT = (mcpUrl: string, origin: string) =>
  `${ONE_LINE_SETUP(mcpUrl)} If you need the steps for this app, read ${origin}/connect and follow them.`;

export function connectMarkdown(input: { mcpUrl: string; origin: string }): string {
  const { mcpUrl, origin } = input;
  return `${ONE_LINE_SETUP(mcpUrl)}

# Connect OpenKT

OpenKT is a team's shared context for AI tools: a remote MCP server (Streamable HTTP) that lets you recall what the team already knows and save what it decides, so it reaches every teammate's tool.

- MCP server URL: ${mcpUrl}
- Name it: \`openkt\`
- Sign-in: OAuth in the browser. The client registers itself (Dynamic Client Registration) and opens an OpenKT page where the person signs in or creates an account, then clicks Allow. There is no API key, and nobody pastes a password or token into a chat.
- Discovery: a request without a token gets \`401\` with \`WWW-Authenticate: Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"\`; the authorization server metadata is at ${origin}/.well-known/oauth-authorization-server.

## Steps per client

- **claude.ai, Claude Desktop, Cowork:** Customize (or Settings) → Connectors → Add custom connector → name \`OpenKT\`, URL \`${mcpUrl}\` → Add → Connect, then sign in on the OpenKT page. Team/Enterprise plans: an owner adds it first under Organization settings → Connectors. Cowork can also install the plugin: Customize → Plugins → Add marketplace → \`masti-ai/OpenKT-ai\` → OpenKT.
- **ChatGPT:** Settings → Security and login → turn on Developer mode. Open https://chatgpt.com/plugins → + → name \`OpenKT\`, MCP server URL \`${mcpUrl}\`, authentication OAuth → Create, sign in. Then add OpenKT to the chat from the tools menu.
- **Codex (CLI, IDE, app):** \`codex mcp add openkt --url ${mcpUrl} && codex mcp login openkt\`. Same as \`[mcp_servers.openkt]\` with \`url = "${mcpUrl}"\` in \`~/.codex/config.toml\`.
- **Claude Code:** \`claude mcp add --transport http --scope user openkt ${mcpUrl}\`, then \`/mcp\` → openkt → sign in. Or the plugin (server + skill + commands): \`/plugin marketplace add masti-ai/OpenKT-ai\`, then \`/plugin install openkt@openkt\`.
- **Cursor:** in \`~/.cursor/mcp.json\`, inside \`mcpServers\`: \`"openkt": { "url": "${mcpUrl}" }\` (merge, do not overwrite), then enable openkt in Cursor's MCP settings and sign in.
- **Any other MCP client or browser agent:** add a remote MCP server (Streamable HTTP) named \`openkt\` with URL \`${mcpUrl}\` and OAuth; leave client ID and secret empty.

Some clients show new tools only in a new chat or after a restart.

## Without a browser (scripts, headless agents)

1. \`POST ${origin}/v1/auth/login\` with JSON \`{"email": "…", "password": "…", "client": "cli"}\` → the access token is \`data.token\` (valid 90 days). New account: \`POST ${origin}/v1/auth/signup\` with \`{"email", "password", "display_name"}\` (password at least 10 characters).
2. Send it on every MCP request: \`Authorization: Bearer <token>\`, with \`Accept: application/json, text/event-stream\`.
   - Codex: \`codex mcp add openkt --url ${mcpUrl} --bearer-token-env-var OPENKT_TOKEN\`
   - Claude Code: \`claude mcp add --transport http openkt ${mcpUrl} --header "Authorization: Bearer $OPENKT_TOKEN"\`
   - Cursor / most JSON configs: \`"openkt": { "url": "${mcpUrl}", "headers": { "Authorization": "Bearer <token>" } }\`
3. Keep the token out of chats and shared files; put it in an environment variable.

## How to work with OpenKT (the contract)

1. **Start:** at the beginning of real work, call \`kt_session_start\` (pass the space if the user names a project, customer or team). Keep the \`session_id\` and pass it to later calls.
2. **Recall:** before non-trivial work, and whenever the user mentions a decision, person, customer, system or "like last time", call \`kt_recall\`. Say whose context you used.
3. **Save:** when something durable is settled (a decision, fact, how-to, issue and its cause, open question, owner and deadline, idea), call \`kt_save_memory\` right then — one short statement that stands on its own. Never save secrets, credentials or private personal data. If the space is unclear, ask once (\`kt_list_projects\` lists the spaces); personal is the default.
4. **Team skills:** when the user asks for something "the way we do it", call \`kt_list_skills\` and follow the matching skill from \`kt_get_skill\`.
5. **End:** when the work is done, call \`kt_session_end\` with a 2–3 sentence summary a teammate could read cold.

Check the connection: call \`kt_session_start\`, then \`kt_list_projects\`.

## More

- The full setup prompt: https://github.com/masti-ai/OpenKT-ai/blob/main/plugin/SETUP-PROMPT.md
- For people (sign in, teams, invite links, access tokens): ${origin}/connect.html
- A team invite link looks like ${origin}/join/<code>: open it in a browser, sign in, and you are in the team.
`;
}
