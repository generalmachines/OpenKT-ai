# OpenKT

OpenKT is an open-source shared context engine for teams and their AI agents.
Sessions from every AI tool you use flow into one place, and a knowledge base maintains itself from them.
Any teammate's tool gets the right context back over MCP, limited to what its owner has been granted.

Apache-2.0. Self-hostable, and no feature is limited to the hosted service.

## Use it in 1 minute

Add the hosted MCP server to any MCP client, then sign in through your browser. There is no token to paste.

```
https://mcp.openkt.ai/mcp
```

- **Any AI tool:** paste [`plugin/SETUP_PROMPT.md`](plugin/SETUP_PROMPT.md) into it. The prompt works out which client it is running in, adds the server, walks you through sign-in and checks that a save and a recall both work. It asks before it changes any file.
- **Claude Code:** install the plugin, which adds the server, the skill and the `/openkt:kt-*` commands:

  ```
  /plugin marketplace add masti-ai/openkt
  /plugin install openkt@openkt
  ```

- **By hand:** [`plugin/README.md`](plugin/README.md) has the steps for Claude Code, claude.ai, ChatGPT, Cursor, Codex, VS Code and Gemini CLI.

## Desktop app (macOS)

Use the Mac app for notes, voice notes and screenshots. Speech and vision both run on your Mac, and the app sends only the text to your team's context.

- Download: [`OpenKT-latest-arm64.dmg`](https://openkt-downloads-724772068721.s3.ap-south-1.amazonaws.com/desktop/OpenKT-latest-arm64.dmg). It needs Apple Silicon and macOS 13.3 or later.
- The build is **not signed or notarised yet**, so macOS blocks it the first time you open it. [`apps/desktop/INSTALL-UNSIGNED.md`](apps/desktop/INSTALL-UNSIGNED.md) shows how to allow it (one setting, or one Terminal line).
- On first launch the app downloads its local models (3 to 5 GB).

![A session in the desktop app, shown with sample data](docs/images/desktop-session.png)

## Self-hosting

A single `docker compose up` is [coming](../../issues/15). Until then, run the server yourself. You need Node 20 or later and Postgres 16 with pgvector, and the setup takes a few commands: see [`server/README.md`](server/README.md). Then point your AI tools at `https://<your-host>/mcp`, and choose your own server on the desktop app's sign-in screen.

## Architecture

![OpenKT system architecture](docs/architecture/system.svg)

Context moves up through four tiers, and each tier points back to the one below. Anything a model tells you can therefore be traced to a person and a moment.

1. **Session.** The raw record of a conversation, meeting, note or screenshot, with its author, source tool and space. Append-only.
2. **Facts.** Single statements extracted from a session, each with a verbatim quote from its source, a kind (decision, how-to, question, …) and tags. Facts are never edited. A newer fact supersedes an older one instead.
3. **Living pages.** One page per topic inside a space. Pages are rewritten as new facts arrive, and every sentence cites its facts. This is the knowledge base that maintains itself.
4. **Brief.** A short digest of a space covering what matters now, what changed and what is still open. It is the first thing an AI tool receives when a session starts.

**Grants** decide who sees what. You grant a person a role (reader, editor, owner) on a workspace, a space, a single session or a skill; teams as grantees are coming. Facts and pages inherit access from their session or space, and pages never merge across spaces.

**Hybrid recall** answers every question with one SQL query. The query first limits itself to what the asking person holds a grant for, and only then ranks. It runs vector search and keyword search over facts (and later over pages), then fuses the two result lists with reciprocal-rank fusion. If nothing relevant comes back, it returns an explicit "nothing found".

To go deeper, read [`docs/architecture.md`](docs/architecture.md) for the full design and [`docs/specs/`](docs/specs/) for the binding decisions.

## Repository map

| Path | What |
|---|---|
| [`apps/desktop/`](apps/desktop/) | The macOS app: Electron, React and Vite, with bundled whisper.cpp, llama.cpp and an Apple Vision OCR helper. |
| [`server/`](server/) | The API, the MCP endpoint and OAuth: NestJS, Drizzle, Postgres and pgvector. It is a standalone npm project, not part of the workspace. |
| [`packages/agents/`](packages/agents/) | Single-purpose LLM agents for the write path. Each has one prompt, one JSON Schema and fixtures. |
| [`packages/recall/`](packages/recall/) | Pure ranking functions: fusion, weights, abstain, diversity and budget. |
| [`packages/pipeline/`](packages/pipeline/) | Pure write-path decisions: chunking, duplicates, tags, guards and the secrets filter. |
| [`packages/mcp-cards/`](packages/mcp-cards/) | The MCP Apps UI cards for save, search results and session summary. |
| [`plugin/`](plugin/) | The Claude plugin, the portable `SKILL.md`, per-tool setup guides and the setup prompt. |
| [`docs/specs/`](docs/specs/) | The decisions that code is written against: memory model, agents, vision and speech, API contract, providers and agent interface. |
| [`docs/`](docs/) | Product, architecture, research, plan and the task list. The index is [`docs/README.md`](docs/README.md). |
| [`design/`](design/) | The design canvas: the approved screens as HTML artboards, plus the scripts that generate them. |
| [`deploy/`](deploy/), [`docker/`](docker/) | How the hosted service is built and deployed (see [`docs/DEPLOY.md`](docs/DEPLOY.md)). |

To develop from the repository root (Node 22):

```
npm ci
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm run dev -w @openkt/desktop      # the app's UI in a browser, with sample data
```

## Status

OpenKT is early software, and nothing has a version number yet. This is where things stand today.

| Area | Works now | Coming |
|---|---|---|
| Hosted service | `api.openkt.ai` and `mcp.openkt.ai` run `main`. Sign-in with email and password; OAuth for MCP clients. | Google sign-in on the hosted service (built, not yet switched on). |
| Sessions and recall | Sessions, saved facts, hybrid recall (vector and keyword with RRF), access enforced inside the query. | The Qwen3 reranker; a recall evaluation set that runs in CI. |
| Sharing | Spaces; grants on workspaces, spaces, sessions and skills; sharing by email; shared skills with versioned files. | Teams as grantees. |
| Knowledge base | Agent prompts and schemas (`packages/agents`), and the first pipeline functions. | Automatic fact extraction, living pages and the space brief. |
| AI tools | MCP tools (`kt_*`), MCP Apps cards, the Claude plugin, the skill and the setup prompt. | End-to-end checks in every client; a JSON-first `kt` CLI ([spec 06](docs/specs/06-agent-interface.md)). |
| Desktop app | Unsigned test builds for Apple Silicon, against the hosted service or your own server: notes, voice notes and screenshots processed on the Mac. | Signed and notarised builds, in-app updates, meeting capture without a bot. |
| Self-hosting | Running the server by hand ([`server/README.md`](server/README.md)). | `docker compose up` ([#15](../../issues/15)). |
| Connectors | — | Notion, Gmail, Google Drive, Obsidian and Linear ([spec 05](docs/specs/05-tool-providers.md)). |

[`PLAN.md`](PLAN.md) lists the versions from 0.1 to 1.0.

## Contributing

People and AI agents are both welcome to contribute. The work is cut into small tasks, each specified completely, so you can pick one up without knowing the whole system. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first, then [`AGENTS.md`](AGENTS.md). Everyone follows the [code of conduct](CODE_OF_CONDUCT.md).

Report security problems privately, as described in [`SECURITY.md`](SECURITY.md).

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
