# Founder brief — OpenKT (Open Knowledge Transfer), September 2026

Raw direction from the founder, consolidated. This is the source of truth for product.md.

## Positioning
- OpenKT is a **shared context engine for teams** — a "context cloud". One confined team knowledge base where context from everyone's tools lands, and from which everyone's AI tools retrieve.
- It started as persistent memory for coding-agent sessions. It is now for **every knowledge worker**, not only engineers.
- **Fully open source (Apache-2.0), self-hostable.** We are not trying to monetise. Any team that wants to share context and wants an open-source, self-hostable solution can run it. Local models, hot-swappable, so people can substitute their own.
- The main product experience is **retrieval**: what one person saved must actually reach a teammate's AI session and visibly improve it, so people have to re-explain less. If retrieval is not good, nothing else matters.
- It should become a **self-evolving knowledge base** — like an Obsidian vault or Notion that writes itself: a local LLM infers what a new piece of context is about and merges it into pre-existing context, rather than piling up snippets.

## Core model
- The unit is a **session**: a coding-harness conversation (Claude Code, Cursor, Codex), a chat in ChatGPT / Claude / GLM via MCP, a personal agent's run, a meeting, a voice note, a screenshot or image, a typed note.
- Anyone can add context with anything — image, meeting, coding session, normal AI session. Every piece is attributed to the **user id** who added it.
- Sessions live in **spaces** (team / project / customer / "ideas"). Access is **RBAC like GitHub**: grant people or teams a role on a space or a single session. Each connector has a **default access** for the new sessions it produces, set in app settings; any session can be overridden.
- Tags/kinds are produced by the local model and adapt to the team's own vocabulary.

## Surfaces
- **MCP first.** Everything must work end-to-end for someone who only connects the MCP server and installs our skill: save, retrieve, sessions. Hooks are an optional enhancement where a harness supports them (better injection and capture) — never the foundation.
- **MCP UI** for headless hosts (claude.ai, ChatGPT, Claude Cowork): cards to search/fetch context, add to context, and pick which team/space it goes to, so the user understands what is happening.
- The whole suite installable as a **plugin** for Claude, and as a **single skill file / paste-able setup prompt** that any team member gives their AI and it sets everything up automatically.
- **Mac desktop app (Electron)**, very smooth, ChatGPT-desktop style and minimal: a list of sessions in a sidebar; a session shows a broad summary/transcript, the context extracted from it, and its access settings. Main settings: connectors, access defaults per connector, models, hotkeys. It is a control pane you rarely need to open.
- **Capture, a function key away** (like Wispr Flow / Aside): hold a function key to dictate a thought or idea into a team space; a hotkey to add a screenshot of what you are looking at (understood by a local vision model, not only OCR); meetings recorded from system audio + mic with **no bot joining**, transcribed locally, then turned into a session with extracted context. Deeply integrated into the same session model, not a bolt-on.
- **Notes and ideas**: note-taking in the app; a team "ideas" structure to drop brainstorms into.
- **Skills and workflows shared across a team**: skill files and shared prompts (e.g. "sharpen a marketing message" used by all of sales), runnable on the local model.
- **Connectors to other tools via Composio** (Notion, Obsidian, Linear, Gmail, …) with ingestion pipelines; prefer existing open-source building blocks over building from scratch.
- **Interactive docs** and the public site at openkt.ai.

## Local vs cloud
- Local models do the private, heavy, personal work: transcription, image understanding, first-pass extraction and tagging. Raw audio stays on the machine.
- A cloud (or self-hosted) server is needed because context is shared with a team: that is where shared context is stored, access is enforced and retrieval happens. Users send only what they choose to share.

## Engineering principles
- Keep the memory engine simple. No over-engineering. Step by step, each version a working version.
- Reuse open-source memory systems and small purpose-built models where they fit.
- The existing codebase is a parts bin, not a constraint: keep what is useful (NestJS + Postgres/pgvector backend, MCP server with OAuth, memory kinds, team briefings), retrofit into the new ideas, and build the UI new.
