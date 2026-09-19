Add this MCP server: https://mcp.openkt.ai/mcp — it signs you in by itself.

> **For people:** copy everything below the line and paste it into the AI tool you use: Claude (web, desktop, Cowork), ChatGPT, Codex, Claude Code, Cursor or a browser agent. It connects OpenKT for you. You sign in in your browser; nobody pastes a password or token into the chat.

---

Add this MCP server: https://mcp.openkt.ai/mcp — it signs you in by itself.

Connect **OpenKT** to the tool you are running in right now. OpenKT is my team's shared context: a remote MCP server at `https://mcp.openkt.ai/mcp` that lets you recall what my team already knows and save what we decide, so it reaches my teammates' tools too. Sign-in is OAuth in my browser (email and password, or "Create an account"). There is no API key.

Rules: never ask me for a password or token in the chat. Before you create or edit any file, show me the change and wait for my yes. Do not install software or run downloaded scripts. If a menu below looks different, say so and use the nearest equivalent.

1. Work out which client this is; ask me if you are not sure. If tools named `kt_…` are already available, skip to step 3.
2. Connect OpenKT in this client. If you cannot do it yourself, give me the exact clicks or command, then wait until I say it is done.
   - **claude.ai, Claude Desktop, Cowork:** Customize (or Settings) → Connectors → Add custom connector → name `OpenKT`, URL `https://mcp.openkt.ai/mcp` → Add → Connect, and sign in. On a Team or Enterprise plan an owner adds it first under Organization settings → Connectors. Cowork can also install the plugin: Customize → Plugins → Add marketplace → `masti-ai/OpenKT-ai` → install OpenKT.
   - **ChatGPT:** Settings → Security and login → turn on Developer mode. Open `https://chatgpt.com/plugins` → + → name `OpenKT`, MCP server URL `https://mcp.openkt.ai/mcp`, authentication OAuth → create, and sign in. Then add OpenKT to the chat from the tools menu.
   - **Codex (CLI, IDE or app):** run `codex mcp add openkt --url https://mcp.openkt.ai/mcp`, then `codex mcp login openkt`. This is the same as adding `[mcp_servers.openkt]` with `url = "https://mcp.openkt.ai/mcp"` to `~/.codex/config.toml`.
   - **Claude Code:** run `claude mcp add --transport http --scope user openkt https://mcp.openkt.ai/mcp`, then `/mcp` → openkt → sign in. Or install the plugin, which adds the OpenKT skill and commands too: `/plugin marketplace add masti-ai/OpenKT-ai`, then `/plugin install openkt@openkt`.
   - **Cursor:** in `~/.cursor/mcp.json`, add `"openkt": { "url": "https://mcp.openkt.ai/mcp" }` inside `mcpServers` (merge; do not overwrite the file), then enable openkt in Cursor's MCP settings and sign in.
   - **A browser agent or any other MCP client:** add a remote MCP server (Streamable HTTP) named `openkt`, URL `https://mcp.openkt.ai/mcp`, authentication OAuth. Leave client ID and secret empty; the server registers the client itself. If this client cannot open a browser to sign in, follow "Without a browser" at `https://mcp.openkt.ai/connect`.
   Some clients show new tools only in a new chat or after a restart. If so, tell me, and continue from step 3 when I paste this again.
3. From now on, whenever you work with me, follow this contract:
   - **Start:** at the beginning of real work, call `kt_session_start` (pass the space if I name a project, customer or team) and keep the `session_id` for every later call.
   - **Recall:** before non-trivial work, and whenever I mention a decision, person, customer, system or "like last time", call `kt_recall`. Say whose context you used.
   - **Save:** when something durable is settled (a decision, fact, how-to, issue and its cause, open question, owner and deadline, idea), call `kt_save_memory` right then: one short statement that stands on its own. Never save secrets, credentials or private personal data. If the space is unclear, ask me once (`kt_list_projects` lists mine); personal is the default.
   - **Team skills:** when I ask for something "the way we do it", call `kt_list_skills` and follow the matching skill from `kt_get_skill`.
   - **End:** when the work is done, call `kt_session_end` with a 2–3 sentence summary a teammate could read cold.
4. Prove it works now: call `kt_session_start` with the title "OpenKT connected from <this client>". Then tell me the session id, the space it opened in, and how many spaces `kt_list_projects` shows me.
