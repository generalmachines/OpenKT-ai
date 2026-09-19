# OpenKT — build plan

The product: `docs/product.md`. The shape of the system: `docs/architecture.md`. The decisions contributor tasks are implemented against: `docs/specs/01…05`. The approved screens: `design/canvas/`.

## Who does what

The work is split in two. Maintainers make the design decisions and build the risky core; everything else is cut into small, fully specified contributor tasks that anyone — a person or an AI agent — can pick up. On GitHub the two kinds carry the labels `senior` (maintainer task) and `junior` (contributor task); the label names are kept because the task tooling depends on them.

**Maintainers (decide, design, build the risky core, review):**
system architecture · the memory model and its overlays (Spec 01) · how every small agent decides (Spec 02) · vision, speech and local reasoning (Spec 03) · the API and MCP contract (Spec 04) · provider and connector interfaces (Spec 05) · agent prompts and JSON schemas · access control and sign-in · the recall SQL · screen design on the canvas · every pull request labelled `needs-senior-review`.

**Contributors (implement one small, fully specified issue at a time):**
pure functions with test tables · migrations written from a given DDL · REST endpoints from a given contract · job handlers from a given flow · UI screens from a given artboard · connectors from a given interface · docs pages from given sources. Rules: `AGENTS.md`.

Every contributor task follows the same shape: *Context → Read first → Do exactly this → Files → Acceptance → Out of scope → Depends on.* The full list is in `docs/tasks/JUNIOR_TASKS.md` and mirrored as GitHub issues.

## Versions — each one works on its own

| Version | Proves | Maintainers build | Contributor tasks |
|---|---|---|---|
| **0.1 Team retrieval over MCP** | Saved by one person, found by a teammate, invisible to a stranger. | sessions, grants, access scope, hybrid recall SQL, MCP session tools, sign-in | recall weighting, diversity, abstain, recall log + feedback, Qwen embeddings, rerank client, secrets filter, job queue, docker compose, evaluation set, meta endpoint |
| **0.2 A knowledge base** | New context updates a page instead of piling up. | agent prompts + schemas, pipeline orchestration review | migrations for pages, chunker, dedupe/tag/route/write guards, confidence, job handlers, pages API, lint job, cards registered in the server, connector defaults |
| **0.3 The app** | Install, sign in, pick tools — done. | missing screens on the canvas, app shell | http adapter, sign-in, tool wiring, Keychain, page editing, packaging |
| **0.4 A function key away** | Say it or screenshot it, and the team has it. | engine protocol, model policy | Swift engine: protocol loop, model manager, hotkey, voice, screenshot + OCR, agent runner, embeddings parity |
| **0.5 Meetings** | A call becomes a shared session, no bot. | capture design, consent rules | system-audio capture, speaker merge, meeting detection |
| **0.6 Your other tools** | Context written elsewhere arrives by itself. | interfaces, permission model | provider registry, local + Composio providers, Obsidian, Notion, Drive, Linear, Gmail connectors, poll job, settings UI |
| **1.0 Anyone can run it** | A stranger can self-host or join a hosted workspace from the docs. | release review | docs site, openkt.ai copy, self-host guide |

## Order of work

```
0.1  #1 import server ─► recall pieces (parallel) ─► evaluation set ─► docker compose
0.2  migrations ─► pure decision functions (parallel) ─► job handlers ─► pages API ─► cards
0.3  app shell (exists) ─► http adapter ─► sign-in ─► tool wiring          (can start during 0.2)
0.4+ engine issues need a Mac; they do not block 0.1–0.3
```

## Definition of done, for any version

The version's "proves" sentence is demonstrated by an automated test, the evaluation set has not regressed, and `docker compose up` from a clean clone still works.
