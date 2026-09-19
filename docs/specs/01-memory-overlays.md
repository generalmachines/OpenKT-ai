# Spec 01 — memory overlays and data model

> Owner: maintainers. Status: decided. Contributor tasks implement this exactly; if something here looks wrong, open an issue labelled `question` — do not improvise.

Vocabulary: **space** is the product word; the database table is still called `projects`. **Fact** is the product word; the table is still called `memories`. Do not rename tables.

## 1. Two kinds of overlay

OpenKT has two independent stacks. Keep them separate in your head.

**Abstraction overlay** (vertical — how raw becomes knowledge). Defined in `architecture.md` §2.

```
T3 brief     one per space            derived, regenerated
T2 page      many per space           living, versioned, cites facts
T1 fact      many per session         immutable, quote-backed
T0 session   the raw record           append-only, then closed
```

**Scope overlay** (horizontal — whose context applies to this question). This spec.

```
S0 this session      facts saved earlier in the same session
S1 personal space    the asker's own private space
S2 named space       the space the tool is working in
S3 other spaces      every other space the asker can read
S4 workspace shared  spaces marked shared_with_workspace = true
```

A recall query searches **all scopes the asker may read, in one SQL statement**, then applies a scope weight. Scopes are never queried one after another.

## 2. Who can read what (the visible set)

`visible_projects(user)` = projects where ANY of:
1. `projects.owner_user_id = user`
2. user is a member of `projects.org_id` AND project visibility is `org` (existing rule — keep)
3. a row in `grants` with `resource_type='project'`, `resource_id=project.id`, `subject_id=user`
4. `projects.shared_with_workspace = true` AND user is a member of `projects.org_id`

`visible_sessions(user)` = sessions where `owner_user_id = user` OR a `grants` row with `resource_type='session'`.

A fact (row in `memories`) is readable when:

| Fact's `visibility` | Readable by |
|---|---|
| `personal` | its `owner_user_id`; plus anyone holding a grant on its **session** |
| `project` / `org` | anyone for whom its project is in `visible_projects` |

A page or brief is readable by anyone for whom its project is in `visible_projects`.

**Hard rule:** the visible set is computed in a CTE at the top of the search SQL and every candidate query joins against it. Filtering after ranking is a bug, even if the result looks the same.

Roles: `reader` can recall. `editor` can also save, edit pages, correct facts. `owner` can also grant, delete, change defaults. A missing grant means no access — there is no "deny" row.

## 3. Tables (additive migrations only)

Existing tables stay. New or changed:

```sql
-- sessions (T0) — the real table names are kt_sessions / kt_session_turns (a legacy component owns `sessions`)
kt_sessions(id uuid pk, org_id uuid null, project_id uuid not null, owner_user_id uuid not null,
         source text not null,          -- claude-code|cursor|codex|chatgpt|claude|mcp|voice|meeting|screenshot|image|note|connector
         client text null,              -- free text: client name + version
         title text null, summary text null,
         status text not null default 'open',   -- open|closed
         started_at timestamptz not null default now(), ended_at timestamptz null,
         last_activity_at timestamptz not null default now(),
         external_id text null, external_url text null, content_hash text null,  -- for connectors
         metadata jsonb not null default '{}')
unique(source, external_id) where external_id is not null

kt_session_turns(id uuid pk, session_id uuid fk, seq int not null, role text not null,  -- user|assistant|speaker|system|note
              speaker text null, content text not null, t0_ms int null, t1_ms int null,
              created_at timestamptz default now(), metadata jsonb default '{}')
unique(session_id, seq)

attachments(id uuid pk, session_id uuid fk, kind text not null,   -- image|audio|file
            mime text not null, bytes int not null, sha256 text not null,
            storage_url text null,      -- null = kept on the user's device only
            description text null, visible_text text null, created_at timestamptz default now())

-- facts (T1) = existing table `memories`, new columns only
memories  + session_id uuid null fk, + source text null,
          + quote text null,              -- verbatim evidence from the session
          + valid_from timestamptz null, + valid_to timestamptz null,
          (keyword column `content_tsv` already exists with a GIN index — reuse it, do not add another)
          (superseded_by, archived, confidence, importance already exist — reuse)
index gin(tsv); index hnsw(embedding vector_cosine_ops)

-- pages (T2)
pages(id uuid pk, project_id uuid fk, slug text, title text, summary text,
      status text default 'active',      -- active|archived
      version int default 1, edited_by_human_at timestamptz null,
      created_at, updated_at)
unique(project_id, slug)

page_sections(id uuid pk, page_id uuid fk, seq int, heading text, body_md text,
              embedding vector(1024), tsv tsvector generated ..., locked boolean default false,  -- locked = a human edited it
              updated_at)
page_section_facts(section_id uuid fk, memory_id uuid fk, primary key(section_id, memory_id))
page_revisions(id uuid pk, page_id uuid fk, version int, snapshot jsonb, reason text,
               actor text,               -- 'agent:write_section' | 'user:<uuid>'
               created_at)

-- briefs (T3)
briefs(project_id uuid pk, brief_md text, source_version_hash text, updated_at)

-- access
grants(id uuid pk, org_id uuid null, resource_type text, resource_id uuid,
       subject_type text default 'user', subject_id uuid, role text,   -- reader|editor|owner
       created_by uuid, created_at)
unique(resource_type, resource_id, subject_type, subject_id)
projects + shared_with_workspace boolean default false

-- connector defaults
connector_defaults(user_id uuid, source text, project_id uuid null, grant_template jsonb default '[]',
                   primary key(user_id, source))

-- retrieval log + feedback
recall_events(id uuid pk, user_id uuid, session_id uuid null, surface text, query text,
              project_id uuid null, returned jsonb,     -- [{type:'fact'|'section', id, rank, score}]
              created_at)
recall_feedback(recall_event_id uuid fk, item_id uuid, used boolean, created_at)

-- background work
jobs(id uuid pk, kind text, payload jsonb, status text default 'queued',   -- queued|running|done|failed
     attempts int default 0, run_after timestamptz default now(), locked_at timestamptz null, error text null,
     dedupe_key text null unique, created_at)
```

Embedding column stays `vector(1024)`. Model: `Qwen/Qwen3-Embedding-0.6B`. Documents are embedded **as-is**; queries are embedded with the prefix `Instruct: Given a question, retrieve team context that answers it\nQuery: `. Store `embedding_model` in `index_meta(key,value)`; refuse to start if it differs from the configured model and `OPENKT_ALLOW_REINDEX` is not set.

## 4. Recall — the exact algorithm

Inputs: `user`, `query`, optional `project_id` (the named space), optional `session_id`, `k` (default 8, max 20).

1. `visible` CTE as §2.
2. Candidates, each restricted to `visible`, each `LIMIT 40`:
   - **A** facts by vector: `memories` where `archived=false AND superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now())`, order by `embedding <=> :q`.
   - **B** facts by keyword: same filter, `content_tsv @@ websearch_to_tsquery(…)` using the same text-search config the column was built with, order by `ts_rank_cd`.
   - **C** page sections by vector. **D** page sections by keyword.
3. Fuse with reciprocal rank fusion: `score = Σ 1 / (60 + rank_in_list)` over the lists the item appears in.
4. Multiply by these weights (constants live in one file, `recall.constants.ts`):

   | Factor | Value |
   |---|---|
   | scope S0 same session | × 1.30 |
   | scope S2 named space | × 1.20 |
   | scope S1 personal | × 1.10 |
   | scope S3 / S4 | × 1.00 |
   | item is a page section | × 1.15 |
   | recency | × (0.85 + 0.15 · exp(−age_days / 90)) |
   | pinned (`is_pinned`) | × 1.25 |
   | hub penalty | × 1 / (1 + 0.15 · ln(1 + recalls_last_30d_without_use)) |
   | human-edited section (`locked`) | × 1.10 |

5. Take the top 50 → rerank with `Qwen3-Reranker-0.6B` through `OPENKT_RERANK_URL` when set. Final score = `0.4 · normalised_fused + 0.6 · rerank_score`. When the URL is unset, skip this step silently.
6. **Abstain:** if reranking ran and the best rerank score < 0.20, return an empty list with `reason: "nothing_relevant"`. Without reranking, abstain when the best vector cosine similarity < 0.30.
7. Diversity: at most 2 sections per page and 3 facts per session in the final list. Drop a fact when a returned section already cites it.
8. Return `k` items, sections first then facts, within a 6,000-character budget. Each item carries: `id, type, text, kind?, tags?, space{id,name}, author{id,name}, session{id,title,source}?, page{id,title}?, created_at, score`.
9. Insert one `recall_events` row. Never block the response on it.

## 5. Write-side rules

- **Facts are immutable.** To change one: insert a new fact and set the old one's `superseded_by` and `valid_to`. Never `UPDATE memories.content`.
- **Quote gate.** A fact coming from extraction must have `quote` that is a substring of its session's turns after normalising whitespace and quote marks. Otherwise it is dropped and counted in the job log. Facts saved directly by a person or by `kt_save_memory` are exempt (`quote` = null).
- **Private by default.** A fact inherits `visibility` from its session's connector default. No default configured → `personal`.
- **Promotion.** `POST /v1/memories/:id/promote {project_id}` copies a personal fact into a space as a new fact with `visibility='project'` and `source_refs.promoted_from`. The original is untouched.
- **Pages never cross spaces.** The router only ever sees candidate pages from the fact's own project. Personal-visibility facts are never written into a page.
- **Page limits.** A section is at most 1,200 characters; a page at most 8 sections. The lint job splits a page that exceeds either.
- **Humans win.** A section with `locked=true` is never rewritten by an agent; new facts for it go to a sibling section titled `Updates`.
- **Every page change writes a `page_revisions` row.** Restoring a revision is a new revision.
- **Brief.** Regenerated when the hash of the space's page summaries changes, at most once every 10 minutes per space. Hard budget 1,500 characters.

## 6. Conflict resolution across overlays

When two readable facts disagree:
1. A fact with `superseded_by` set is never returned — the successor is.
2. Otherwise both may be returned; the newer one ranks higher through the recency factor, and each carries its date and author. **The engine does not pick a winner across spaces** — a personal note must not silently override a team decision, nor the reverse. The asking model sees both with attribution.
3. Inside one space, the `dedupe` agent is responsible for marking supersession at write time (Spec 02 §3).
