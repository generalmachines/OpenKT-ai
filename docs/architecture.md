# OpenKT — architecture

> Status: draft 1, 2026-09-19. Derived from `product.md`. Research behind the choices: `research/` (memory systems, local models, MCP Apps / packaging / ingestion).

The rule for this document: every box must be needed by the version it first appears in. Nothing is built ahead of the version that uses it.

## 1. Shape

```
  any AI tool ──MCP──┐                         ┌── Postgres 16 + pgvector (+ pg_textsearch)
  desktop app ──HTTP─┼──►  openkt server  ─────┼── model endpoint   (any OpenAI-compatible: generation)
  connectors ──HTTP──┘     (NestJS, one        └── inference sidecar (TEI/Infinity: Qwen3 embed + rerank)
                            process + worker)
```

- **One server, one database.** No graph database, no message broker. Background work uses a Postgres job table (`SKIP LOCKED`); the existing SQS/RabbitMQ backends remain optional adapters.
- **Two model dependencies**, both swappable by URL: a generation endpoint (extraction, merging, briefs) and an inference sidecar for embeddings (Qwen3-Embedding-0.6B) and reranking (Qwen3-Reranker-0.6B).
- **The embedding model is pinned per workspace** (`Qwen/Qwen3-Embedding-0.6B`, 1024-d, last-token pooling, L2-normalised, query-side instruction prefix). It replaces BGE-M3: stronger on multilingual retrieval, 32K context, Apache-2.0, a 0.3 GB MLX build — and the same 1024 dimensions, so the column does not change; existing rows are re-embedded once. It is recorded in index metadata and is not user-swappable without a reindex; client-side embedding must pass a golden-vector parity test (cosine ≥ 0.999) or the server re-embeds.
- `docker compose up` brings up all of it.

## 2. Memory model — four tiers, one direction

Context only ever flows upward, and every tier keeps a pointer to the tier below, so anything a model says can be traced to a person and a moment.

| Tier | What it is | Written by | Mutable | Used for |
|---|---|---|---|---|
| **T0 · Session** | The raw record: turns or transcript segments, attachments, source connector, author, space. | The connector | Append-only, then closed | Provenance; last-resort retrieval; re-extraction when models improve |
| **T1 · Fact** | One atomic, self-contained statement with a verbatim source quote, a kind, tags, author, `valid_from`/`valid_to`, `superseded_by`. | Extraction (local or server) | Immutable — superseded, never edited | Precise retrieval; evidence for pages |
| **T2 · Page** | A living topic inside one space. Markdown body in sections, each sentence citing facts; revisions kept. | The merge step; people | Yes, versioned; human edits win | The default retrieval unit; what people read |
| **T3 · Brief** | A compact digest of a space (and of a workspace): what matters now, what changed, what is open. | Derived from pages on change | Regenerated | Session priming — the first thing a tool receives |

Why this shape:
- **Facts are immutable** because every mature system that tried in-place updates backed out of it (mem0 removed UPDATE/DELETE in v3). Merging happens one layer up, where it is visible and reversible.
- **Pages are per space and never merge across spaces**, so the knowledge base cannot leak across a grant boundary by construction.
- **Every fact carries a verbatim quote that must be found in its session**, or it is dropped. This is the cheap, mechanical guard against small-model hallucination.
- **Sessions stay retrievable**, so a weak extraction loses nothing permanently.

Kinds are a small fixed set the UI can rely on (decision, fact, how-to, question, action, idea, issue); **tags are free and model-assigned**, drawn first from the space's existing tag vocabulary so they converge on the team's own words.

### The pipeline is small agents, one job each

Every model call in the write path is a **single-purpose agent**: one system prompt, one JSON Schema for its output, one narrow input. No agent sees more than it needs or decides more than one thing. Output is always schema-constrained JSON (`response_format: json_schema`, validated again on receipt, one retry, then a safe no-op) — never free text. One model serves all of them: **Qwen3.5-4B**, a vision-language model, with thinking turned off.

| Agent | Input | Output (JSON) | Must not |
|---|---|---|---|
| `extract` | one session chunk | `facts[] {statement, quote, kind}` | tag, merge, or see other sessions |
| `tag` | one fact + the space's tag vocabulary | `tags[]` (prefers existing tags) | rewrite the fact |
| `dedupe` | one fact + its 10 nearest existing facts | `duplicate_of? · supersedes[]` | touch pages |
| `route` | fact batch + top-k candidate pages in the same space (titles + summaries) | `action: append \| rewrite_section \| new_page \| noop` + target | write prose |
| `write_section` | one page section + the facts to fold in | new section markdown with citations | change other sections |
| `summarise` | one session | `title, summary, open_questions[]` | extract facts |
| `describe_image` | one image | `description, visible_text, entities[]` | anything else |
| `brief` | a space's page summaries + recent changes | `brief_md` | read sessions |

Agents live in one package (`packages/agents`): prompt, schema, fixtures and an evaluation per agent. The server and the desktop engine run the same definitions. Swapping the model is a URL change; swapping an agent's behaviour is a prompt-and-schema change with its own test.

### Write path

```
session closes ─► chunk ─► extract facts (JSON-schema constrained, quote-gated, dedupe vs top-10 neighbours)
               ─► embed + index facts
               ─► for each fact batch: find top-k candidate pages IN THE SAME SPACE
                    └─ model chooses: append | rewrite_section | new_page | noop   (+ mark superseded facts)
               ─► re-embed changed sections ─► regenerate the space brief if the page change is material
nightly lint  ─► split oversized pages, flag stale/orphaned ones, close dangling sessions
```

Extraction may run on the user's machine (desktop capture) or on the server (sessions arriving over MCP). The server accepts pre-extracted facts but always re-validates the quote gate and owns merging.

### Read path — the product

One SQL statement, access enforced before ranking:

```
visible   := spaces and sessions the asker holds a grant on        -- CTE from grants
candidates:= vector top-N  ∪  BM25 top-N   over page sections and facts, WHERE space/session ∈ visible
fused     := reciprocal-rank fusion (k = 60)
             × recency prior × (valid_to IS NULL) × retrieval-frequency penalty      -- no hub pages
reranked  := cross-encoder over the top 50
answer    := pages first, facts as backup, per-page cap, diversity (MMR), character budget
             each item with author, source session, date, and a stable id
```

- Scope: a named space searches that space plus anything shared workspace-wide; no space searches everything visible, personal space first.
- Every retrieval is logged (`who, tool, query, returned ids`). A later `kt_feedback` or an observed citation marks items as used; that signal feeds the ranking prior and the success measures in `product.md`.
- The system abstains. "Nothing relevant" is a valid, explicit result.
- A fixed evaluation set (≈50 questions over real sessions, with expected sources and at least ten access-control traps) runs on every change to extraction, merging or ranking. No published benchmark is trusted over it.

## 3. Access

```
grant(resource_type ∈ {workspace, space, session, skill}, resource_id,
      subject_type ∈ {user, team},  subject_id,  role ∈ {reader, editor, owner})
```

- Facts, pages and attachments have no grants of their own; they inherit from their session or space. A fact extracted from a private session stays private until the session is shared or the fact is *promoted* to the space.
- A connector carries a default `(space, grant set)` applied to each session it opens; any session can be overridden.
- Access tokens carry scopes that are actually enforced (`context:read`, `context:write`, `admin`).
- One guard resolves "what can this principal see" once per request; services never re-implement it.

## 4. MCP first

The server is the product. Everything below works with nothing installed but the connection.

**Session lifecycle over MCP.** The 2026-07-28 MCP revision removes protocol-level sessions, so a session is an OpenKT object:

| Tool | Does |
|---|---|
| `kt_session_start(space?, title?)` | Opens a session, returns `session_id` and the space brief (T3). |
| `kt_recall(query, space?, session_id?)` | Grant-filtered retrieval. |
| `kt_save(content, session_id?, space?, access?)` | Saves context now — at decision points, not only at the end. |
| `kt_session_end(session_id, summary)` | Closes the session with the model's own summary. Idle sessions close themselves. |
| `kt_spaces()` · `kt_page(id)` · `kt_feedback(ids, used)` · `kt_setup()` | Browse, read, signal, and return paste-able setup steps for the detected client. |

The contract — when to start, recall, save and end — lives in the server `instructions` and the tool descriptions (kept under 2 KB each, since some clients truncate). Model-initiated saving is treated as **lossy but sufficient**: every other memory product pairs it with hooks for full capture, and so do we, as an enhancement.

**Enhancement layers, each optional:**
1. *Skill file* (`SKILL.md`, the open Agent Skills format) — loads in Claude, Codex, Cursor, Gemini CLI, Copilot and others; teaches the tool the contract and sets up the connection.
2. *Plugin* for Claude Code and Cowork — wraps the same remote server by URL, adds the skill, slash commands, and hooks of type `http`/`mcp_tool` (SessionStart → prime, Stop → upload the turn delta) so no local scripts are needed.
3. *Desktop app* — full local capture.

**MCP Apps cards.** One `ui://` HTML bundle, registered with `@modelcontextprotocol/ext-apps`, renders in claude.ai, Claude Desktop, ChatGPT, Cursor and VS Code: a *save* card with a space and access picker (listing only spaces the user can write to), a *results* card, a *session summary* card. App-only tools (`visibility: ["app"]`) perform the writes. Tools always return meaningful text as well; clients without the extension get form elicitation where supported, plain arguments otherwise.

**Auth.** OAuth 2.1 with PKCE as today; add Client ID Metadata Documents alongside dynamic client registration, which the new spec deprecates.

## 5. Desktop app

- **Electron shell** (React), built screen-for-screen from the design canvas. Talks only to the server's HTTP API — it has no private backend.
- **Swift engine inside the app bundle**, one signed helper the user never sees: global hotkeys, microphone and system-audio capture, and all local inference through `mlx-swift-lm` (LLM, vision, embeddings, reranking, JSON-schema-guided generation) and `speech-swift` (streaming ASR, Omnilingual ASR, diarization, VAD, echo cancellation). Apple Silicon, macOS 15+.
- One provider protocol with two backends: in-process MLX by default, or any OpenAI-compatible URL the user supplies.
- **One model family.** Default bundle ≈ 4 GB resident: Qwen3.5-4B (text *and* vision, 4-bit, 3.0 GB) · Qwen3-Embedding-0.6B (0.3 GB) · Qwen3-Reranker-0.6B (0.3 GB). Lite bundle for 8 GB Macs: Qwen3.5-2B (1.7 GB) in place of the 4B. All Apache-2.0. Known weakness, designed around: Qwen3.5-4B is unreliable at structure when unconstrained, so it always runs with thinking off and schema-guided decoding (`MLXGuidedGeneration` in-process, `json_schema` over HTTP). Picks are re-checked against our own evaluation set, including Thai and Hindi.

## 6. Connectors to other products

A thin native interface, one small module per product:

```
backfill(cursor) · poll(cursor) · webhook?(event) · permissions(item)
```

Each external document, thread or meeting becomes one session with `source, external_id, url, author, timestamps`, de-duplicated on `(source, external_id, content_hash)`. **One connector instance maps to one space** (a Slack channel, a Notion teamspace, a Drive folder); per-item permission mirroring comes later and only where it is cheap. Logic is borrowed from MIT-licensed readers (LlamaIndex, Onyx connectors) and Unstructured for parsing. Obsidian is a local folder watch. Google Meet transcripts arrive through the Drive connector.

**Tool providers are plugins.** Where the tokens and API calls come from is a swappable provider behind one interface:

```
ToolProvider: connect(user, app) → connection · list(connection, cursor) → items · fetch(item) → document · subscribe?(connection) → events
```

**Composio is the first provider, shipped as a plugin**: a team pastes its own Composio API key, members connect Gmail, Notion, Linear and the rest through Composio's hosted sign-in, and OpenKT pulls documents through it. A second, keyless provider covers local sources (an Obsidian vault, a folder). Anyone can write another provider — direct OAuth apps, Nango, an in-house gateway — without touching the core. "Open source" here means our orchestration and product are open and swappable; it does not mean every dependency must run on the team's own hardware.

## 7. What is reused from the existing code

| Keep (evolve in `openkt-server`, then publish as a clean-history snapshot) | Drop |
|---|---|
| NestJS skeleton, Drizzle, migrations discipline | MemMachine + Neo4j |
| MCP controller, OAuth 2.1 server, consent flow, PAT issuance | The directory-bound project model |
| LLM gateway with provider abstraction and call ledger | The visibility enum (replaced by grants) |
| Embed and triage stages (dedupe, supersede) → become extraction + merge | Per-memory eager fan-out through a broker |
| Team briefings → T3 briefs; member knowledge → later | The old dashboard UI |
| Synthesis test harness and its 350-item corpus → the evaluation set | Python hook scripts as a requirement |

One real gap for self-hosting: sign-in is bound to Supabase today. v0.1 adds built-in email + OIDC sign-in so a self-hosted server needs no third party.

## 8. Versions — each one works

| Version | Proves | Contains |
|---|---|---|
| **0.1 Team retrieval over MCP** | Something one person saved reaches a teammate's tool, and a stranger's cannot see it. | Sessions, facts, grants, spaces, hybrid grant-filtered recall with rerank, session tools + instructions, `SKILL.md`, built-in sign-in, docker compose, evaluation set. |
| **0.2 A knowledge base** | The store improves itself. | Living pages, briefs, supersede, nightly lint, feedback signal, MCP Apps cards, Claude plugin with optional hooks. |
| **0.3 The app** | Zero-terminal setup; people can see and steer. | Electron shell from the canvas: sessions, session view, access, spaces, pages, connectors, models. |
| **0.4 A function key away** | Capture beyond AI tools. | Swift engine, voice and screenshot capture, local extraction, notes and the ideas space. |
| **0.5 Meetings** | Bot-less meetings become shared sessions. | System audio, diarization, consent state. |
| **0.6 The rest of your tools** | Context already written elsewhere arrives on its own. | Connector interface; Obsidian, Notion, Drive, Slack, Linear; shared skills registry. |
| **1.0** | Anyone can run it. | Docs site on openkt.ai, self-host guide, signed builds. |

The repository is public from 0.1 — it starts with a clean history, so there is nothing to scrub.
