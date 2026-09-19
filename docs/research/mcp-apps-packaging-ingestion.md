> Research report, 2026-09-19. Agent-gathered from primary sources; unverified items are listed at the end of each report.

The three answers: build the cards as MCP Apps (one resource works in Claude and ChatGPT), keep the remote MCP server as the product with plugins as thin optional wrappers, and don't put Composio in the core. Everything below was checked on 2026-09-19 against the pages linked. Items I could not confirm are listed at the end.

## A. MCP UI / MCP Apps

**Current standard.** MCP Apps (SEP-1865) is the one standard. It went Final on 2026-01-28 and is an official extension, `io.modelcontextprotocol/ui`, of the 2026-07-28 spec.
- The tool declares its UI with `_meta.ui.resourceUri` pointing at a `ui://` resource, MIME type `text/html;profile=mcp-app`.
- The host renders it in a sandboxed iframe and talks to it over JSON-RPC on postMessage.
- Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- Overview: https://modelcontextprotocol.io/extensions/apps/overview
- `@mcp-ui/server` and `@mcp-ui/client` (Apache-2.0) now implement this same spec: https://github.com/MCP-UI-Org/mcp-ui
- ChatGPT implements the same bridge. Its old `openai/outputTemplate` and `text/html+skybridge` are kept only as aliases for existing integrations: https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt

**Hosts that render it today.**
- Claude surfaces: claude.ai web, Claude Desktop, mobile and Cowork (Cowork and mobile come from a search summary of Anthropic's blog, not a page I read).
- Others: ChatGPT, VS Code Copilot, Cursor, Goose, M365 Copilot, Postman, MCPJam.
- Not Claude Code: it isn't in the official matrix (a secondary source says the terminal can't render it).
- Matrix: https://modelcontextprotocol.io/extensions/client-matrix

**One resource for both Claude and ChatGPT.**
- Server: `registerAppTool()` and `registerAppResource()` from `@modelcontextprotocol/ext-apps`.
- Client: `App.connect()` with no transport argument; the SDK detects the host.
- Claude wants `_meta.ui.domain` set to `sha256(serverUrl)[:32].claudemcpcontent.com`.
- Feature-detect `window.openai` extras such as `widgetState`; don't branch on host name.
- Recipe: https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility.md

**Callbacks from the UI.**
- The iframe can send `tools/call` (proxied by the host to the same server), `ui/message`, `ui/update-model-context`, `ui/open-link` and `ui/request-display-mode`.
- Tools marked `visibility:["app"]` are hidden from the model and callable only by the iframe.

**Sandbox and CSP.**
- Default policy: `default-src 'none'`, `connect-src 'none'`, inline script and style allowed.
- Anything more must be declared in `_meta.ui.csp` (`connectDomains`, `resourceDomains`, `frameDomains`).
- Web hosts use a double iframe.
- Claude shows a confirmation on `ui/open-link` unless the origin is allowlisted in the directory listing.

**Fallback for hosts with no UI.**
- The spec requires tools to return a meaningful `content` array even when UI is available, and says servers should keep a text-only fallback. Hosts without Apps support just ignore `_meta.ui`.
- Register UI tools only when the client advertises the extension.
- Otherwise use form elicitation for the space and access picker, and plain text arguments as the last resort.

**Elicitation support.**
- Claude Code: yes, with a dialog and an `Elicitation` hook (https://code.claude.com/docs/en/mcp).
- Cursor: yes since 1.5 (secondary source, not a Cursor page I read). VS Code Copilot: yes, per a community comparison only.
- Claude connectors: elicitation is not in the supported list (https://claude.com/docs/connectors/building).
- In 2026-07-28 elicitation is no longer a server-initiated request. The server returns `InputRequiredResult` and the client retries the call.

**Recommendation.** Copy supermemory's MCP server (MIT), which already does what you want:
- `guided-save` opens a form listing only the spaces the user can write to (`writableTags`).
- `select-space` is a space picker.
- App-only tools (`save-memory`, `set-active-tag`) do the actual writes.
- The active space is stored as application state keyed by org and user, not per MCP session.
- Source: https://github.com/supermemoryai/supermemory/tree/main/apps/mcp

For OpenKT that maps to `kt_save_card`, `kt_search_card` and `kt_session_summary_card` sharing one `ui://openkt/app-<hash>.html` bundle, plus an app-only `kt_commit_save`.

## B. Packaging and an MCP-only lifecycle

**Anthropic's own guidance** is a remote OAuth MCP server first, then a plugin with skills that wraps it by URL (https://claude.com/docs/connectors/building/what-to-build).
- Remote MCP servers work on claude.ai, Desktop, mobile, Cowork and Claude Code.
- Plugins load only in Claude Code and Cowork. Skills cannot be submitted to the directory alone; they must sit inside a plugin.
- Plugin layout: `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `userConfig`. Hooks can be of type `http` or `mcp_tool`, so a Stop hook can call OpenKT without a local script (https://code.claude.com/docs/en/plugins-reference).
- Install is `claude plugin install x@marketplace`; validate with `claude plugin validate`.

**Other channels.**
- `.mcpb` is for local servers and only Claude Desktop installs it, so it doesn't apply to a remote server (https://github.com/modelcontextprotocol/mcpb).
- Directory submission needs a Team or Enterprise org, a `title` plus `readOnlyHint` or `destructiveHint` on every tool, OAuth, a privacy policy URL, a test account, and 3–5 PNG screenshots for an MCP App (https://claude.com/docs/connectors/building/submission).
- Agent Skills (`SKILL.md`) load in Codex and ChatGPT, Cursor, Gemini CLI, OpenCode, Copilot and VS Code, Goose, Amp, Kiro, Roo and 40+ others (https://agentskills.io).
- Skills over MCP (SEP-2640, Final) lets a server serve `skill://` resources via `skills/list`. Client support is thin so far: ChatGPT partial, fast-agent partial (https://modelcontextprotocol.io/extensions/skills/overview).

**The 2026-07-28 spec changes your server.** It removes `initialize`, `Mcp-Session-Id` and protocol sessions. It deprecates Sampling, Roots and DCR (in favour of Client ID Metadata Documents). Details: https://modelcontextprotocol.io/specification/latest/changelog
- So a "session" has to be an OpenKT concept: `kt_session_start` returns a server-minted `session_id` that later calls pass as an argument, as the spec itself suggests.
- Don't plan on sampling to obtain transcripts. Claude connectors never supported it.
- Add Client ID Metadata Documents alongside DCR.

**MCP-only lifecycle.**
1. Put the contract in server `instructions`. Claude Code truncates instructions and tool descriptions at 2KB each. With tool search on, only tool names and instructions load at session start.
2. `kt_session_start(project)` returns the brief plus a `session_id`.
3. `kt_recall` before non-trivial work.
4. `kt_save_memory` at decision points, not only at the end.
5. A `kt_session_end(summary)` prompt or slash command.
6. Close idle sessions server-side. Without hooks the server never sees the transcript, only what the model writes.

**What others do.** None of these rely on model-initiated saving for capture.
- supermemory ships MCP plus a Claude Code plugin with SessionStart, UserPromptSubmit and an async Stop hook that captures new conversation content (https://github.com/supermemoryai/claude-supermemory).
- mem0 ships per-harness plugin marketplaces in its repo: `.claude-plugin`, `.codex-plugin`, `.cursor-plugin`.
- claude-mem (94k stars, Apache-2.0) is capture-first by design: it describes itself as capturing everything the agent does in a session.
- Graphiti (Zep's engine) is a deliberate `add_memory` tool driven by server instructions.
- basic-memory is AGPL-3.0.

**Recommendation.** The remote MCP server is the product, with instructions plus session tools. `kt_setup` should return the paste-able setup steps per detected client. Ship one `SKILL.md` in a repo that is both a Claude marketplace and a generic skills source, with hooks as an optional extra. Treat model-initiated saves as lossy.

## C. Composio and ingestion

**Composio.**
- The SDK is MIT (https://github.com/ComposioHQ/composio); the backend is closed.
- Self-host or VPC is Enterprise only, and the platform images are closed source, per secondary sources (Nango's blog and similar, not Composio docs).
- Pricing: Free is 100k tool calls and 50k trigger events per month. Scale is $29/month plus $0.0003 per call and $0.003 per trigger event (https://composio.dev/pricing).
- It offers triggers delivered by webhook or SDK subscription. I found no bulk-sync or backfill feature in the one docs page I read.
- Verdict: fine as an optional hosted auth broker. It must not be a core dependency of an Apache-2.0 self-hosted product.

**Licences, read from each repo's LICENSE file.**

| Tool | Licence |
|---|---|
| Unstructured | Apache-2.0 |
| LlamaIndex readers (notion, obsidian, slack, google, linear, confluence) | MIT |
| Meltano | MIT (taps exist on its hub for slack, notion, linear and gmail; tap licences not checked) |
| Onyx connectors | MIT |
| Onyx permission sync (`backend/ee/onyx/external_permissions`) | Enterprise licence |
| Activepieces | MIT, with separately licensed EE directories |
| Nango | ELv2; free self-host gives auth and proxy only — syncs, webhooks and triggers need Enterprise or Cloud (https://nango.dev/docs/guides/platform/free-self-hosting/configuration) |
| Airbyte platform, the connectors I checked (notion, slack, google-drive, gmail, linear), and PyAirbyte | ELv2 |
| n8n | Sustainable Use (fair-code) |
| Pipedream | Source-available |

**Recommendation.** Write a thin native connector interface: `backfill(cursor)`, `poll(cursor)`, optional `webhook()`, and `permissions(item)`. Borrow logic from Onyx's MIT connectors and the LlamaIndex readers; use Unstructured for parsing.
- Each external document, thread or meeting becomes one "session" carrying `source`, `external_id`, `url`, `author`, `timestamps` and `acl_snapshot`. De-duplicate on `(source, external_id, content_hash)`.
- Default permission model: one connector instance maps to one space (a Slack channel, Notion teamspace or Drive folder each maps to a space). Per-item ACL mirroring comes later, and only for Google Drive and Slack.
- Use Nango or Composio only as swappable OAuth-token providers.
- Obsidian is a local `kt` CLI folder watch that pushes changed notes, with frontmatter choosing the space.
- For Google Meet, transcripts are Docs in Drive, so the Drive connector plus Calendar attendees can set the space.

## Not verified
- claude.ai, Desktop and Cowork elicitation. It is absent from the supported list but not explicitly denied. ChatGPT elicitation.
- Any measured figure for how reliable model-initiated saving is. The claim rests on what vendors do plus one Hjarni Blog note that Graphiti/Zep saves are deliberate, not automatic.
- Hook support inside Cowork plugins. Whether the `domain` field is required for Claude to render an App.
- The VS Code display-mode limits and ChatGPT's "no tools/call from UI" reported by a secondary source; OpenAI's docs contradict the latter.
- Composio polling intervals and per-app trigger coverage. Whether Composio really has no backfill.
- mcp-availability.com was unreachable. Claude's 2026-07-28 rollout is "in progress" according to Zuplo, a secondary source.
