# OpenKT documentation

Read in this order. Each layer is derived from the one above it, so when two documents disagree, the one higher in this list wins — except that a spec wins over an issue.

## 1. Product

- [`product.md`](product.md) — what OpenKT is, the problem, who it is for, the core concepts (workspace, space, session, context, living page, grant, connector, skill), the feature set, principles and non-goals. Change the product here first.

## 2. Architecture

- [`architecture.md`](architecture.md) — the shape of the system: one server and one Postgres, the four memory tiers (session, fact, page, brief), the single-purpose agents of the write path, the read path, access, the MCP surface, the desktop app, connectors, and what each version contains.

## 3. Specs

The binding decisions. Code is written against these; if an issue and a spec disagree, the spec wins. Changing one starts as an issue labelled `question`.

- [`specs/01-memory-overlays.md`](specs/01-memory-overlays.md) — the memory model, scopes and the recall ranking.
- [`specs/02-agent-decisions.md`](specs/02-agent-decisions.md) — when each agent runs, what it may see, and what code decides without a model.
- [`specs/03-vision-and-speech.md`](specs/03-vision-and-speech.md) — images, speech and local reasoning in the desktop engine.
- [`specs/04-api-contract.md`](specs/04-api-contract.md) — the REST API, the MCP tools and server instructions, sign-in.
- [`specs/05-tool-providers.md`](specs/05-tool-providers.md) — tool providers and connectors to other products.

## 4. Research

Notes written for the maintainers before the specs were decided. They address the project as "you", compare other systems as they stood in September 2026, and end in recommendations — some taken, some not. The specs record what was decided.

- [`research/memory-systems.md`](research/memory-systems.md) — open-source memory systems, and what to borrow.
- [`research/local-models.md`](research/local-models.md) — local models for text, vision, speech, embeddings and reranking.
- [`research/mcp-apps-packaging-ingestion.md`](research/mcp-apps-packaging-ingestion.md) — MCP Apps, packaging for AI tools, and ingestion from other products.

## 5. Tasks

- [`../PLAN.md`](../PLAN.md) — the versions, and who builds what.
- [`tasks/JUNIOR_TASKS.md`](tasks/JUNIOR_TASKS.md) — every task in full, mirrored as GitHub issues. Generated: edit [`tasks/issues.py`](tasks/issues.py) and run `python3 docs/tasks/build.py`.
- [`../AGENTS.md`](../AGENTS.md) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how to pick up a task.

In the task files, `senior` marks a maintainer task and `junior` a contributor task. These are the GitHub label names; they describe the task, not the person.

## 6. History

- [`history/2026-09-founder-brief.md`](history/2026-09-founder-brief.md) — the founder's original direction, kept unedited. `product.md` was written from it.

## Elsewhere in the repository

- [`../server/WHERE_THINGS_LIVE.md`](../server/WHERE_THINGS_LIVE.md) — a map of the server code.
- [`../plugin/README.md`](../plugin/README.md) — connecting AI tools.
- [`../design/canvas/`](../design/canvas/) — the approved screens.
- [`images/`](images/) — screenshots used by the READMEs.
