# OpenKT — product

> Status: draft 1, 2026-09-19. Written from the founder's brief ([`history/2026-09-founder-brief.md`](history/2026-09-founder-brief.md)). Architecture, docs and the website derive from this file; change it here first.

## What it is

OpenKT is an open-source shared context engine for teams.

Every tool a team works in — a coding agent, a chat assistant, a meeting, a thought said out loud — produces context that dies when the session ends. OpenKT captures each session, distils what is worth keeping into a team knowledge base that maintains itself, and hands the right pieces back to any teammate's AI tool over MCP, within the access its owner allowed. Use a hosted instance or run your own; the models and the tool providers are swappable, and everything we build is Apache-2.0.

## The problem

People now spend a real part of their day explaining things to AI tools: how the team deploys, what the customer asked for, which approach was already tried and dropped. That explanation is work, and it is thrown away three times over.

- **Between sessions.** Tomorrow's session starts cold.
- **Between tools.** What you told your coding agent, your chat assistant never hears. Meetings and hallway thoughts reach no tool at all.
- **Between people.** A teammate's agent re-derives what yours learned last week, or gets it wrong.

Wikis do not fix this because nobody writes them, and AI tools cannot read the ones that exist in a permission-aware way. Personal memory features do not fix it because they stop at one person and one vendor.

## Who it is for

**An engineer on a small team.** *Before:* every new agent session re-scans the repo and re-learns that staging uses a different port. *After:* the agent starts with the team's decisions and gotchas for that project, including the ones a colleague's session discovered yesterday.

**A salesperson.** *Before:* the pricing objections from Tuesday's call live in her head and a notes app. *After:* the call became a session on its own; when a colleague asks their assistant to draft a proposal for the same customer, the ask for per-store pricing is already in front of it.

**A founder or team lead.** *Before:* ideas said out loud between meetings are gone by evening. *After:* hold a key, say the idea, and it lands in the team's ideas space, merged with the earlier thinking on the same theme.

**A marketer or operations person.** *Before:* "our voice" is a document nobody opens, and everyone prompts differently. *After:* the team shares one skill — "sharpen a marketing message" — that any tool can run with the current positioning attached.

## Core concepts

**Workspace.** One team's installation: its people, spaces and settings. A self-hosted server can hold one or many.

**Space.** A place context is filed: a project, a customer, a team, "ideas". Spaces are not tied to folders or repositories. Every person has a private personal space, so nothing is ever dropped for lack of somewhere to put it.

**Session.** The unit of capture: one conversation with a coding agent or chat assistant, one run of a personal agent, one meeting, one voice note, one screenshot or image, one typed note. A session records who created it, which connector it came from, a timeline (turns or transcript segments), attachments, and the space it is filed in.

**Context.** A short, self-contained statement distilled from a session — a decision, a fact, a how-to, an open question, an action, an idea. Each item keeps a link to the session and person it came from. Kinds and tags are assigned by a model and adapt to the team's vocabulary.

**Living page.** The knowledge-base unit. A page is a topic inside a space ("Northgate — pricing", "Auth — token refresh") whose body is maintained by a model: when new context arrives, the model decides which page it belongs to, merges it in, marks what it supersedes, and keeps citations to the underlying context. Pages are what make the store a knowledge base rather than a pile of snippets. People can read and edit them like a wiki.

**Grant and role.** Access works like a code host. A grant gives a person or a team a role — reader, editor, owner — on a workspace, a space, or a single session. Context and pages inherit from where they live. Retrieval only ever returns what the asking person holds a grant for.

**Connector.** Anything that produces sessions: an MCP-connected AI tool, the desktop capture features, or an integration with another product. Each connector has a default — where its new sessions are filed and who can use them — which the owner can override on any one session.

**Skill.** A shared, versioned instruction — a prompt or a skill file — with grants like everything else. A skill can be run on the local model in the app, or fetched by any connected tool together with the context it needs.

## How it works

1. **Capture.** A session begins in a connected tool, or the user holds a key and speaks, takes a screenshot, or accepts "record this meeting". *(Local for desktop capture; the AI tool's own runtime otherwise.)*
2. **Understand.** On the user's machine, local models transcribe audio, describe images, and make a first pass at extracting context and tags. Raw audio stays on the machine. *(Local.)* Sessions arriving from a chat tool over MCP skip this step and are distilled on the server.
3. **File.** The session is assigned a space and the connector's default access. *(Local or server.)*
4. **Sync.** The session's text, extracted context and attachments the user chose to keep are sent to the team's server. *(Server.)*
5. **Merge.** The server's model places each new piece of context on a living page — updating, superseding, or creating — and indexes it for search. The model endpoint is any OpenAI-compatible one, so a team can run it locally. *(Server.)*
6. **Retrieve.** A teammate's AI tool asks OpenKT for context — at the start of a session and whenever the model needs it. The server runs keyword and vector search together, filters by the asker's grants, reranks, and returns pages and context with their sources. *(Server.)*
7. **Learn.** What was retrieved and whether it was used feeds back into ranking, and stale or contradicted context is demoted. *(Server.)*

## Feature set

**Retrieval**
- *Grant-aware hybrid search (v1).* Keyword and vector search, reranked, filtered by access. This is the product; everything else feeds it.
- *Session priming (v1).* A compact brief for a space, returned when a session starts. Tools begin warm instead of cold.
- *Feedback-driven ranking (v2).* Retrieval and use signals adjust what surfaces. Keeps popular-but-useless items from dominating.

**Capture**
- *Save and session tools over MCP (v1).* Any MCP client can open a session, save context and close it, with no hooks. The baseline that must always work.
- *Harness hooks (v2).* Where a tool supports hooks, capture and injection happen automatically. An enhancement, never a requirement.
- *Voice, screenshots and images (v2).* Hold a function key to speak; a hotkey to capture what is on screen, understood by a local vision model.
- *Meetings without a bot (later).* System audio and microphone, transcribed and attributed to speakers locally.

**Sharing and access**
- *Spaces, grants and roles (v1).* The minimum for a team to trust a shared store.
- *Connector defaults and per-session overrides (v2).* Sensible privacy without per-item decisions.

**Knowledge base**
- *Living pages (v2).* Model-maintained topics with citations. Turns accumulation into knowledge.
- *Notes and an ideas space (v2).* Write directly; notes are sessions like any other.
- *Edit and correct (v2).* People can fix a page; corrections outrank extraction.

**Skills**
- *Shared skills and prompts (later).* Versioned, granted, runnable locally or from any tool.

**Desktop app (macOS)**
- *Session list, session view, access, connectors, models (v2).* A control pane you rarely need to open. Built from the design canvas.
- *Zero-terminal setup (v2).* Install, sign in, pick tools; the app wires them.

**MCP and MCP UI**
- *Remote MCP server with OAuth (v1).* Works with chat assistants and coding tools alike.
- *Interactive cards (v2).* Search results, "save to…" with a space and access picker, session summary — so people see what is happening in tools with no OpenKT interface of their own. Plain-text fallback everywhere.
- *One-file setup (v1).* A skill file or paste-able prompt that lets a person's own AI connect and configure OpenKT.

**Connectors to other products**
- *Ingestion from documents, trackers and mail (later).* Each external item becomes a session with its source attributed. Built on existing open-source connector projects.

**Self-hosting**
- *One server, one Postgres (v1).* Use a hosted instance or run `docker compose up`. No graph database, no message broker required.
- *Hot-swappable models and tools (v1).* Any OpenAI-compatible endpoint for generation; tool providers such as Composio are plugins a team can replace.

## Principles

- **Retrieval quality is the product.** A feature that does not make the right context reach the right session is secondary.
- **MCP first.** Everything works with only the MCP server connected. Hooks improve it where they exist.
- **Local-first inference.** Private and heavy work — audio, images, first-pass extraction — happens on the user's machine.
- **Open and self-hostable.** Apache-2.0, no hosted-only features, models anyone can swap.
- **A simple engine.** Plain Postgres, a small number of concepts, each version a working version. Adopt open-source parts before writing new ones.
- **Attribution always.** Every item knows who added it and where it came from.

**Non-goals.** OpenKT is not a chat assistant, an agent framework, a meeting-notes app for one person, a document editor competing with Notion, or a general enterprise search engine. It does not train models on team data. It does not join calls as a bot.

## Privacy and trust

- Raw audio and unshared screenshots never leave the machine. Local transcripts stay local until the session is shared or filed to a shared space.
- Only text, extracted context and explicitly kept attachments sync, to a server the team controls.
- Access is enforced inside the retrieval query, not after it; a model never sees context the asker has no grant for.
- Every retrieval is logged with who asked, from which tool, and what was returned.
- Meeting capture shows a visible recording state and reminds the user to tell participants; a workspace can require explicit confirmation or disable recording.

## Success measures

- **Reach.** Share of sessions in which retrieved context was authored by someone other than the asker.
- **Use.** Share of retrieved items the model actually cites or acts on, measured from the session that followed.
- **Re-explanation.** How often people restate, in a prompt, something the store already held.
- **Freshness.** Rate at which retrieved items are later corrected or superseded.
- **Time to first value.** From install to the first session where a teammate's context was retrieved.
- **Offline evaluation.** A fixed corpus of sessions and questions, run on every change to extraction, merging or ranking.

## Open questions

- How reliably do chat tools without hooks open, save and close sessions on their own, and how much does a skill file improve that?
- What is the right size and lifetime of a living page, and when should pages split or merge?
- How much team-level synthesis can small local models do well, and where does a larger model earn its cost?
- How should an external tool's own permissions map onto spaces during ingestion?
- What does consent for bot-less meeting capture need to look like across jurisdictions?
- Is an embedded native engine inside an Electron app the right shape for capture on macOS?
