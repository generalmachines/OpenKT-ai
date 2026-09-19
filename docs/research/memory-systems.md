> Research report, 2026-09-19. Agent-gathered from primary sources; unverified items are listed at the end of each report.

# OpenKT memory engine: open-source options and recommended architecture (2026-09-19)

Repo metadata comes from the GitHub API today; behaviour claims come from each project's README and docs. Items I could not confirm are marked unverified.

## 1. Comparison of the top candidates

| System | Licence · stars · last release | Language / storage | Graph DB needed | Local LLM | Multi-user and ACL at retrieval | Update / merge | MCP | Self-host effort |
|---|---|---|---|---|---|---|---|---|
| [Hindsight](https://github.com/vectorize-io/hindsight) | MIT · 24k · v0.10.0 (09-14) | Python server with a TS client; Postgres + pgvector only | No (entity links are stored in Postgres) | Yes: ollama, lmstudio, llamacpp, any OpenAI-compatible endpoint | One bank per query, plus `tags` / `tag_groups` boolean filters. The default `any` mode also returns untagged rows. | Facts feed consolidated "observations" that carry evidence and history; near-duplicates merge at 0.97 cosine similarity. It also has mental models and knowledge pages. | Built in, one endpoint per bank | Low |
| [mem0](https://github.com/mem0ai/mem0) | Apache-2.0 · 66k · releases daily | Python and TS SDKs; 15 vector stores | No (graph memory was removed from the OSS version in v3) | Yes | `user_id` / `agent_id` / `run_id` filters only, with no ACL | v3 (April 2026) is ADD-only with MD5 dedupe and does no UPDATE or DELETE. Conflicts are left to retrieval ranking. | Yes | Low |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | MIT · 27k · v2.0 | TypeScript; SQLite by default, MongoDB experimental, no Postgres | No | OpenAI-compatible base URL | Best of the group: private / team / restricted visibility with User, Role and Agent ACLs, and scope is narrowed before retrieval | Layers from L0 conversation to L1 atom, L2 scenario and L3 persona, plus an LLM-maintained Wiki | Capture runs through an LLM proxy; it exposes a tools API | Medium (3 services) |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0 · 31k · v0.30.2 | Python | Yes: Neo4j, FalkorDB or Neptune (Kuzu is deprecated) | Weak: the docs warn that small models fail its structured output | `group_id` namespaces only | Best of the group: bi-temporal edge invalidation | Yes | High |
| [cognee](https://github.com/topoteretes/cognee) | Apache-2.0 · 31k · v1.6.0 (09-18) | Python | The Postgres graph store is a demo only; the production version is a licensed product | Yes | Dataset-level ACL with tenants and roles | Re-runs its "cognify" processing step | Yes | Medium |
| [supermemory](https://github.com/supermemoryai/supermemory) | MIT · 30k | TS; the local server is one binary with an embedded engine | Embedded | Ollama | Local mode is single-org with a single API key; teams require Enterprise | Knowledge-update chains | Yes | Low, but single-user |
| [memU](https://github.com/NevaMind-AI/memU) | Apache-2.0 · 14k · v1.5.1 (March) | Python; SQLite or pgvector | No | Embeddings only; the host agent does the LLM work | None | The agent writes Markdown for a shared "LLM wiki" and skills | Via CLI | Low |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | AGPL-3.0 · 4k · v0.23.2 | Python; Markdown files plus SQLite or Postgres | No | Not applicable | Teams exist only in the cloud product | The agent edits notes | Yes | Low |

The rest I would not adopt:
- [Letta](https://github.com/letta-ai/letta): its V1 server is archived and the project has pivoted to the `letta-code` agent harness, so it is no longer a memory library.
- [Memobase](https://github.com/memodb-io/memobase): no commits since January 2026. It needs Postgres plus Redis and builds per-user profiles.
- [LangMem](https://github.com/langchain-ai/langmem): tied to LangGraph and has never had a tagged release.
- [MemOS](https://github.com/MemTensor/MemOS): self-hosting requires Neo4j plus Qdrant.
- [A-MEM](https://github.com/agiresearch/A-mem): research code, inactive since December 2025.
- [LongMemory](https://github.com/CaviraOSS/LongMemory): this is the renamed CaviraOSS OpenMemory. It is TypeScript on SQLite, its README claims tenant, team and role scope enforcement, and it uses decay. It is worth a skim.
- [AtomicMemory](https://github.com/atomicstrata/atomicmemory): Apache-2.0 TypeScript core with supersede, clarify and delete operations. Its local mode needs Docker and an OpenAI key, per the README.
- mem0's own OpenMemory subproject: current state not verified.
- [MemMachine](https://github.com/MemMachine/MemMachine): the dependency you already want to drop. Its last release was in May.

Licence red flags for an Apache-2.0 project:
- AGPL: basic-memory, OpenViking, honcho, ParadeDB `pg_search`
- BSL 1.1: dnotitia/akb
- GPL-3: nashsu/llm_wiki, inkeep/open-knowledge
- Licence unclear from GitHub metadata: Memori, byterover-cli, VectorChord-bm25

## 2. Top three: what to adopt and what to borrow

**Hindsight.** It is the only candidate that meets every constraint: one Postgres, MIT, local models, a TypeScript client, and merge semantics.
- Adopt: run it as a sidecar on the same Postgres instance and call it through `@vectorize-io/hindsight-client`.
- Borrow:
  - recall that runs four strategies (semantic, BM25, graph, temporal), fuses them with RRF (k=60) and reranks with a cross-encoder ([docs](https://hindsight.vectorize.io/developer/retrieval));
  - observation consolidation, which keeps evidence quotes and records how a belief evolved instead of overwriting it ([docs](https://hindsight.vectorize.io/developer/observations)).
- Friction:
  - Recall covers one bank at a time.
  - ACL is done with tags. You would map each org to a bank and each space or session to a tag, and resolve a user's grants into a tag list with `any_strict`.
  - Its built-in MCP endpoint bypasses your grants, so keep it internal.

**mem0 v3.**
- Adopt: nothing. Its access model is user-ID filters only.
- Borrow:
  - the single-pass ADD-only extraction prompt (Apache-2.0);
  - the pattern of retrieving the top-10 related memories as dedupe context;
  - entity-overlap boosting as a third retrieval signal.
- mem0 removed both UPDATE/DELETE and the graph from its OSS version ([migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3)). That is evidence that fact rows should be immutable and merging should happen one layer up.

**TencentDB Agent Memory.**
- Adopt: nothing. It has no Postgres backend and needs three services.
- Borrow:
  - the L0 to L3 layering;
  - its semantics of private by default with explicit sharing;
  - "narrow the permission scope first, then retrieve";
  - the fallback from L2/L3 to L1/L0 with caps on item count and character budget;
  - the Wiki layer, which follows the [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern of ingest, query and lint over an `index.md` and a `log.md`.
- It is MIT and TypeScript, so the code can be ported into NestJS directly.

## 3. Recommendation: own the SQL, port the prompts, add one model-serving sidecar

Grant-filtered retrieval is the core of the product. I would not push it through another system's tag model.

**(a) Session to facts.** Add a stage to your existing worker.
- Port mem0 v3's ADD-only extraction prompt. It makes one LLM call per session chunk and asks for JSON only.
- Store immutable `facts` rows with `session_id`, `user_id`, `space_id`, `quote_span`, `embedding` and `tsv`.
- Require every fact to carry a verbatim source quote and drop any fact whose quote is not found in the session.

**(b) Living pages.**
- Use three tables: `pages(space_id, slug, title, body_md, summary, embedding, version)`, `page_revisions` and `page_facts` for evidence.
- For each new batch of facts, search for the top-k candidate pages in the same space.
- The LLM then chooses one of `append`, `rewrite_section`, `new_page` or `noop`. Rewrites should note contradictions ("was X, since date Y") in the Hindsight style.
- Add a Graphiti-style `valid_to` and `superseded_by` on facts.
- Run a nightly "lint" job to find stale, orphaned or oversized pages.
- Pages are scoped per space, so a merge never crosses a grant boundary.

**(c) Retrieval.** A single SQL statement:
- Start with a CTE of the session and space IDs the caller is allowed to see, taken from the grants table.
- Run a pgvector HNSW query and a BM25 query over that set. For BM25 use [pg_textsearch](https://github.com/timescale/pg_textsearch) (PostgreSQL licence, v1.4.0) and fall back to native `tsvector`.
- Fuse the two result lists with RRF and take the top 50.
- Rerank those with `bge-reranker-v2-m3` served by TEI or Infinity. This is the only new sidecar, and it can also serve BGE-M3.
- Return pages first and facts as backup, within a character budget.

**Process.** Time-box a one-day Hindsight spike as the quality baseline before you port anything. Ship (a) plus (c) as v1 and (b) as v2.

## 4. Failure modes and the cheapest mitigations

- **Context bleed.**
  - Permissive defaults are the main source. Hindsight's default `any` mode returns untagged rows.
  - Filter in SQL before ranking, never after.
  - Never merge across spaces.
  - Do not run one system's MCP endpoint alongside your own.
- **Stale facts.**
  - An ADD-only store relies entirely on ranking to surface the current fact.
  - Add `valid_to` and a recency prior.
  - Pages should state the current value plus its history.
- **Hub or attractor pages.**
  - Large pages match every query.
  - Cap page size and split oversized pages.
  - Embed per section.
  - Apply a retrieval-frequency penalty. You have already seen this work in Villa.
  - Apply an MMR-style diversity step (maximal marginal relevance) and a per-page cap on results.
- **Extraction hallucination.**
  - Local models below roughly 14B tend to invent facts and break JSON output.
  - Use the verbatim-quote gate and constrained decoding, and keep L0 raw sessions retrievable.
  - mem0's benchmark answer prompt reportedly tells the model never to say "no information found", so have your system abstain instead.
- **Benchmarks.** Treat every published number as marketing.
  - An audit found 6.4% of LoCoMo's answer key is wrong and that its LLM judge accepted 63% of deliberately wrong answers ([Penfield Labs](https://penfieldlabs.substack.com/p/proposal-a-new-benchmark-for-long)).
  - LongMemEval-S fits inside a modern context window, so it tests context length more than memory.
  - Zep and mem0 publicly dispute each other's scores ([Zep's post](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)).
  - Build a 50-question evaluation set from real OpenKT sessions and use that to decide.
