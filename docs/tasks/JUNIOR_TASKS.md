# Task breakdown

> Generated from `docs/tasks/issues.py` — edit that file, then run `python3 docs/tasks/build.py`. Mirrored as GitHub issues.

How to work: read `AGENTS.md`. Pick a task marked **junior** whose dependencies are closed. One task = one branch = one pull request.


---

## Version 0.1 Team retrieval over MCP

| Task | Who | Title | Depends on |
|---|---|---|---|
| #1 S1 | senior | Import the server into this repository as `server/` | — |
| #2 S2 | senior | Built-in sign-in (email link + OIDC) so a server needs no third party | #1 |
| #5 J1 | junior | recall: reciprocal rank fusion `fuse()` | — |
| #6 J2 | junior | recall: constants file and `applyWeights()` | #5 |
| #7 J3 | junior | recall: `shouldAbstain()` | #6 |
| #8 J4 | junior | recall: `finalize()` — diversity, citation de-duplication, budget | #6 |
| #9 J5 | junior | recall: rerank HTTP client with score blending | #6 |
| #10 J6 | junior | pipeline: secrets filter `findSecrets()` | — |
| #11 J7 | junior | server: `recall_events` + `recall_feedback` tables, logging and the feedback endpoint | #1 |
| #12 J8 | junior | server: switch embeddings to Qwen3-Embedding-0.6B with an index guard and a re-embed script | #1 |
| #13 J9 | junior | server: Postgres job queue (`jobs` table + worker loop) | #1 |
| #14 J10 | junior | server: `GET /v1/meta` and 404-instead-of-403 audit | #1 |
| #15 J11 | junior | `docker compose up` for the whole stack | #1, #12 |
| #16 J12 | junior | Evaluation set: 50 questions with expected sources and access traps | #1 |


### S1 · Import the server into this repository as `server/`  #1

`senior`

**Context.** The v0.1 backend work (sessions, grants, access scope, hybrid recall, MCP session tools) is being finished on branch `feat/context-cloud-v0.1` of the private `openkt-server` repository. It moves here as a clean snapshot so all work happens in one place.

**Do exactly this**
1. Finish and verify milestones M1–M6 on the branch.
2. Scan the tree for secrets; remove deploy-specific files.
3. Copy `api/` to `server/` in this repository, add it to the npm workspaces, make `npm test` pass from a clean clone.
4. Write `server/WHERE_THINGS_LIVE.md` for junior engineers.

**Acceptance — every line must be true and tested**
- [ ] `server/` builds and its unit tests pass from a clean clone.
- [ ] No secret, account id or internal hostname in the tree.

**Depends on:** nothing — can start now


### S2 · Built-in sign-in (email link + OIDC) so a server needs no third party  #2

`senior` `blocked`

**Context.** Sign-in is bound to Supabase today (Spec 04, Auth). Authentication is not a junior task.

**Do exactly this**
1. Issue the server's own JWTs; keep accepting Supabase JWTs while `OPENKT_SUPABASE_JWKS_URL` is set.
2. Email magic link and OIDC (Google, GitHub).
3. Enforce PAT scopes `context:read`, `context:write`, `admin`.
4. Add Client ID Metadata Documents beside Dynamic Client Registration.

**Acceptance — every line must be true and tested**
- [ ] The v0.1 proof test passes with built-in sign-in only.
- [ ] A read-only token calling a write tool gets 403 `insufficient_scope`.

**Depends on:** #1


---

## Version 0.3 The app

| Task | Who | Title | Depends on |
|---|---|---|---|
| #3 S3 | senior | Design the missing app screens on the canvas | — |
| #31 J40 | junior | desktop: implement the `http` API adapter against Spec 04 | #1 |
| #32 J41 | junior | desktop: connect tools from the app (write each tool's MCP config) | #3 |
| #33 J42 | junior | desktop: page view editing and revision history | #3, #28 |
| #34 J43 | junior | desktop: macOS packaging, signing placeholders and auto-update wiring | — |


### S3 · Design the missing app screens on the canvas  #3

`senior`

**Context.** Screens are built only from the canvas. Missing: sign-in, transcript tab, hotkeys, access defaults, page editing, empty states, provider setup (Composio key), connector container picker.

**Do exactly this**
1. Design each on the canvas in the established look.
2. Export the artboards to `design/canvas/`.

**Acceptance — every line must be true and tested**
- [ ] Each listed screen exists as an artboard file.

**Depends on:** nothing — can start now


---

## Version 0.2 A knowledge base

| Task | Who | Title | Depends on |
|---|---|---|---|
| #4 S4 | senior | Review and tune agent prompts against the evaluation set | — |
| #17 J20 | junior | pipeline: `chunkTurns()` | — |
| #18 J21 | junior | pipeline: `quoteGate()` | #10 |
| #19 J22 | junior | pipeline: `capFacts()` and `mapKind()` | — |
| #20 J23 | junior | pipeline: `decideDuplicate()` and `guardSupersede()` | — |
| #21 J24 | junior | pipeline: `normaliseTags()` with vocabulary convergence | — |
| #22 J25 | junior | pipeline: `guardRoutes()` | — |
| #23 J26 | junior | pipeline: `validateSection()` and `fallbackAppend()` | — |
| #24 J27 | junior | pipeline: `assignConfidence()` | — |
| #25 J30 | junior | server: migrations and schema for pages, sections, revisions, briefs, attachments, connector defaults | #1 |
| #26 J31 | junior | server: job handlers J1–J4 (summarise, extract, embed, classify) | #13, #17, #18, #19, #20, #21, #24, #25 |
| #27 J32 | junior | server: job handlers J5–J8 (route, write section, brief, lint) | #26, #22, #23 |
| #28 J33 | junior | server: pages and briefs REST API + `kt_page` tool | #27 |
| #29 J34 | junior | server: register the MCP Apps cards | #1 |
| #30 J35 | junior | server: connector defaults API | #25 |


### S4 · Review and tune agent prompts against the evaluation set  #4

`senior`

**Context.** Prompts and schemas in `packages/agents` are senior-owned (AGENTS.md rule 5).

**Do exactly this**
1. Run `npm run eval -w @openkt/agents` against Qwen3.5-4B.
2. Tune until valid-JSON ≥ 99 % and quote-gate drops < 15 %.
3. Record the table in `packages/agents/EVAL.md`.

**Acceptance — every line must be true and tested**
- [ ] EVAL.md committed with the table and the model id used.

**Depends on:** nothing — can start now


### J1 · recall: reciprocal rank fusion `fuse()`  #5

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Recall merges a vector list and a keyword list into one ranking (Spec 01 §4 step 3).

**Read first**
- docs/specs/01-memory-overlays.md §4
- `packages/recall/src/types.ts`

**Do exactly this**
1. Create `packages/recall/src/fuse.ts` exporting `fuse(candidates: Candidate[], k = 60): (Candidate & { fused: number })[]`.
2. For each candidate: `fused = Σ 1 / (k + rank)` over the ranks present in `candidate.ranks` (`vector`, `keyword`). A missing rank contributes 0.
3. Return a new array sorted by `fused` descending; ties broken by `id` ascending so the order is stable. Do not mutate the input.
4. Throw `InvalidInputError` if any rank is < 1 or not an integer, or if a candidate has no rank at all.
5. Add `export * from "./fuse.js";` to `src/index.ts`.

**Files you may touch**
- `packages/recall/src/fuse.ts`
- `packages/recall/test/fuse.test.ts`
- `packages/recall/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] vector rank 1 only → fused = 1/61.
- [ ] vector rank 1 + keyword rank 1 → 2/61, and it sorts above an item with vector rank 1 only.
- [ ] vector 3 + keyword 10 → 1/63 + 1/70.
- [ ] Two items with equal fused come out ordered by id.
- [ ] Input array is unchanged after the call.
- [ ] rank 0, rank 1.5, and an item with `ranks: {}` each throw `InvalidInputError`.
- [ ] `npm run typecheck -w @openkt/recall && npm test -w @openkt/recall` pass.

**Out of scope**
- Weights, reranking, SQL.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j1` · **Rules:** `AGENTS.md`

### J2 · recall: constants file and `applyWeights()`  #6

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** After fusion each item is multiplied by fixed weights (Spec 01 §4 step 4). All numbers live in one file so they can be tuned in one place.

**Read first**
- docs/specs/01-memory-overlays.md §4 (the weights table)
- `packages/recall/src/types.ts`

**Do exactly this**
1. Create `packages/recall/src/constants.ts` exporting `RECALL` as a frozen object: `scope: { S0: 1.30, S1: 1.10, S2: 1.20, S3: 1.00, S4: 1.00 }`, `sectionBoost: 1.15`, `pinnedBoost: 1.25`, `lockedBoost: 1.10`, `recencyFloor: 0.85`, `recencySpan: 0.15`, `recencyHalfLifeDays: 90`, `hubPenalty: 0.15`, `rrfK: 60`, `rerankBlend: 0.6`, `abstainRerank: 0.20`, `abstainCosine: 0.30`, `maxSectionsPerPage: 2`, `maxFactsPerSession: 3`, `charBudget: 6000`, `candidateLimit: 40`, `rerankTop: 50`.
2. Create `packages/recall/src/weights.ts` exporting `applyWeights(items: (Candidate & { fused: number })[], now: Date): (Candidate & { fused: number; weighted: number })[]`.
3. `weighted = fused × scope × (type==='section' ? sectionBoost : 1) × recency × (is_pinned ? pinnedBoost : 1) × (locked ? lockedBoost : 1) × hub`.
4. `recency = recencyFloor + recencySpan × exp(−ageDays / recencyHalfLifeDays)` where `ageDays = max(0, (now − created_at) in days)`.
5. `hub = 1 / (1 + hubPenalty × ln(1 + recalls_30d_unused))`.
6. Return a new array sorted by `weighted` descending, ties by `id`. Export both files from `src/index.ts`.

**Files you may touch**
- `packages/recall/src/constants.ts`
- `packages/recall/src/weights.ts`
- `packages/recall/test/weights.test.ts`
- `packages/recall/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] A brand-new S3 fact, not pinned, 0 unused recalls: weighted = fused × 1.00 (recency = 1.0). Use `toBeCloseTo`.
- [ ] Same item aged 90 days: recency = 0.85 + 0.15/e ≈ 0.9052.
- [ ] A created_at in the future is treated as age 0.
- [ ] S0 beats S2 beats S1 beats S3 for otherwise identical items.
- [ ] A section beats an identical fact.
- [ ] recalls_30d_unused = 20 gives hub ≈ 1/(1+0.15×ln 21) ≈ 0.6865.
- [ ] `RECALL` is frozen: assigning to a field throws in strict mode.
- [ ] typecheck and tests pass.

**Out of scope**
- Changing any constant value.

**Depends on:** #5

**Branch:** `task/<issue-number>-j2` · **Rules:** `AGENTS.md`

### J3 · recall: `shouldAbstain()`  #7

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** OpenKT says "nothing relevant" instead of returning weak matches (Spec 01 §4 step 6).

**Read first**
- docs/specs/01-memory-overlays.md §4 step 6
- `packages/recall/src/constants.ts`

**Do exactly this**
1. Create `packages/recall/src/abstain.ts` exporting `shouldAbstain(items: { rerank?: number; similarity?: number }[]): boolean`.
2. Empty list → true.
3. If at least one item has `rerank` defined: return `max(rerank) < RECALL.abstainRerank`.
4. Otherwise: return `max(similarity ?? 0) < RECALL.abstainCosine`.
5. Export from `src/index.ts`.

**Files you may touch**
- `packages/recall/src/abstain.ts`
- `packages/recall/test/abstain.test.ts`
- `packages/recall/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] [] → true.
- [ ] rerank [0.19, 0.05] → true; [0.20] → false.
- [ ] no rerank, similarity [0.29] → true; [0.30] → false.
- [ ] rerank present on one item only → the rerank rule is used.
- [ ] items with neither field → true.
- [ ] typecheck and tests pass.

**Depends on:** #6

**Branch:** `task/<issue-number>-j3` · **Rules:** `AGENTS.md`

### J4 · recall: `finalize()` — diversity, citation de-duplication, budget  #8

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The last step turns a ranked list into what the tool receives (Spec 01 §4 steps 7–8).

**Read first**
- docs/specs/01-memory-overlays.md §4 steps 7–8
- `packages/recall/src/types.ts`
- `packages/recall/src/constants.ts`

**Do exactly this**
1. Create `packages/recall/src/finalize.ts` exporting `finalize(ranked: Scored[], k: number): Scored[]`. `ranked` is already sorted best-first.
2. Clamp `k` to 1..20.
3. Walk the list in order and keep an item unless: (a) it is a section and 2 sections of the same `page_id` are already kept; (b) it is a fact and 3 facts with the same `session_id` are already kept (facts without `session_id` are not limited); (c) it is a fact whose `id` is in the `cites` of a section already kept; (d) adding its `text.length` would push the running total above `RECALL.charBudget` — skip it and keep walking, shorter items may still fit.
4. Stop when `k` items are kept.
5. Return kept items ordered: all sections first (in kept order), then all facts (in kept order).
6. Do not mutate the input. Export from `src/index.ts`.

**Files you may touch**
- `packages/recall/src/finalize.ts`
- `packages/recall/test/finalize.test.ts`
- `packages/recall/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] 3 sections of one page in → 2 out.
- [ ] 4 facts of one session in → 3 out.
- [ ] A fact cited by a kept section is dropped; the same fact is kept when that section was itself dropped by rule (a).
- [ ] A 5,900-char item followed by a 200-char and a 50-char item → first and third are kept.
- [ ] k = 0 → 1 item; k = 99 → at most 20.
- [ ] Output has sections before facts even when a fact ranked first.
- [ ] typecheck and tests pass.

**Depends on:** #6

**Branch:** `task/<issue-number>-j4` · **Rules:** `AGENTS.md`

### J5 · recall: rerank HTTP client with score blending  #9

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The top 50 candidates are re-scored by a cross-encoder served over HTTP (Spec 01 §4 step 5). The server may be TEI or Infinity; both accept the TEI shape.

**Read first**
- docs/specs/01-memory-overlays.md §4 step 5
- `packages/recall/src/constants.ts`

**Do exactly this**
1. Create `packages/recall/src/rerank.ts` exporting `createReranker(opts: { url?: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch })` returning `{ rerank(query: string, items: Scored[]): Promise<Scored[]> }`.
2. `url` undefined or empty → `rerank` resolves to the input unchanged, with `score = weighted` on every item. No network call.
3. Otherwise POST `${url}/rerank` with JSON `{ "query": query, "texts": items.map(i => i.text), "raw_scores": false }`, header `Authorization: Bearer <apiKey>` only when set. Response is `[{ "index": number, "score": number }]`.
4. Normalise `weighted` to 0..1 by dividing by the max `weighted` in the batch (max 0 → all 0). Set `rerank` from the response and `score = (1 − RECALL.rerankBlend) × normalised + RECALL.rerankBlend × rerank`.
5. Only the first `RECALL.rerankTop` items are sent; the rest keep `score = 0.4 × normalised` and no `rerank`.
6. Timeout (default 3000 ms), non-2xx, malformed body, or wrong array length → **do not throw**: return the no-rerank result and call `opts.onError?.(err)` if provided (add `onError?: (e: unknown) => void` to opts).
7. Return sorted by `score` descending, ties by `id`. Export from `src/index.ts`.

**Files you may touch**
- `packages/recall/src/rerank.ts`
- `packages/recall/test/rerank.test.ts`
- `packages/recall/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] No url → no fetch call (assert with a spy) and scores equal weighted.
- [ ] With a fake `fetchImpl` returning scores, an item with low weighted but rerank 0.95 ends up first.
- [ ] The request body matches the shape above exactly (assert on the spy).
- [ ] HTTP 500, a thrown fetch, a body that is not an array, and an array of the wrong length each return the fallback and call `onError` once.
- [ ] A request slower than `timeoutMs` falls back (use fake timers or a never-resolving fetch + AbortSignal).
- [ ] 60 items in → only 50 texts in the request.
- [ ] typecheck and tests pass.

**Out of scope**
- Choosing or hosting the rerank model.

**Depends on:** #6

**Branch:** `task/<issue-number>-j5` · **Rules:** `AGENTS.md`

### J6 · pipeline: secrets filter `findSecrets()`  #10

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** OpenKT never stores credentials, even when a person asks it to (Spec 02 §9).

**Read first**
- docs/specs/02-agent-decisions.md §9

**Do exactly this**
1. `packages/agents/src/secrets.ts` already has a first version — copy it as your starting point (copy, do not import across packages), then make every test in this issue pass.
2. Create `packages/pipeline/src/secrets.ts` exporting `findSecrets(text: string): { type: string; index: number }[]` and `hasSecret(text: string): boolean`.
3. Detect, with one named regex each: `aws_access_key` (`AKIA` or `ASIA` + 16 uppercase alphanumerics); `github_token` (`gh[pousr]_` + 36 or more alphanumerics); `openai_key` (`sk-` + 20 or more of `[A-Za-z0-9_-]`); `anthropic_key` (`sk-ant-` …); `slack_token` (`xox[baprs]-` …); `openkt_pat` (`okt_pat_` + 20 or more); `private_key` (`-----BEGIN [A-Z ]*PRIVATE KEY-----`); `jwt` (three base64url parts separated by dots, the first starting `eyJ`, each part ≥ 10 chars); `connection_string` (`scheme://user:password@host` for schemes postgres, postgresql, mysql, mongodb, mongodb+srv, redis, amqp — the password part must be non-empty); `password_assignment` (case-insensitive `password`, `passwd`, `pwd`, `secret` or `api[_-]?key`, then optional spaces, then `is`, `=` or `:`, then a value of 6+ non-space characters that is not `null`, `none`, `true`, `false`, `required`, `missing`, `<…>` or `***`); `card_number` (13–19 digits, optional spaces or dashes between groups, passing the Luhn check).
4. Return matches sorted by `index`. Never include the matched text in the result.
5. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/secrets.ts`
- `packages/pipeline/test/secrets.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] One positive test per type using an obviously fake value (for example `AKIAIOSFODNN7EXAMPLE`, card `4242 4242 4242 4242`).
- [ ] Negatives that must NOT match: `the password is required`, `password: <your password>`, `sk-` alone, `postgres://localhost:5432/db` (no credentials), a 16-digit number failing Luhn, a git commit SHA, a UUID, the sentence `we rotate the API key every quarter`.
- [ ] `findSecrets` results never contain the secret string (assert the returned objects have only `type` and `index`).
- [ ] typecheck and tests pass.

**Out of scope**
- Entropy-based detection.
- Redaction.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j6` · **Rules:** `AGENTS.md`

### J7 · server: `recall_events` + `recall_feedback` tables, logging and the feedback endpoint  #11

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Every recall is logged so we can measure whether retrieved context was used (Spec 01 §3, Spec 04 `POST /v1/recall/:recall_id/feedback`).

**Read first**
- docs/specs/01-memory-overlays.md §3
- `docs/specs/04-api-contract.md (Context section)`
- `server/WHERE_THINGS_LIVE.md`

**Do exactly this**
1. Add one migration creating `recall_events` and `recall_feedback` exactly as in Spec 01 §3, with an index on `recall_events(user_id, created_at desc)`. Append its entry to the migrations journal with a `when` value larger than every existing entry.
2. Add the two Drizzle schema files and export them from the schema index.
3. In the recall service, after the response is built, insert one `recall_events` row. It must not delay or fail the response: no `await` on the hot path, errors are logged and swallowed.
4. Return `recall_id` in the recall response and in the `kt_recall` MCP tool's `structuredContent`.
5. Add `POST /v1/recall/:recall_id/feedback` with body `{ used: uuid[], unused?: uuid[] }`. Only the user who made the recall may post; anyone else gets 404. Ids not present in the event's `returned` list are ignored. Upsert one `recall_feedback` row per id. Respond 204.
6. Add the MCP tool `kt_feedback { recall_id, used }` calling the same service.

**Files you may touch**
- `server/**/migrations/<next>_recall_events.sql`
- `server/**/db/schema/recall-events.ts`
- the recall service
- a new `recall-feedback.controller.ts`
- the MCP server factory
- one spec file per new unit

**Acceptance — every line must be true and tested**
- [ ] A recall returns a `recall_id`, and a row exists with the returned ids in rank order.
- [ ] If the insert throws, the recall still returns 200 (test with a repository mock that rejects).
- [ ] Feedback from another user → 404. Feedback with an unknown id → 204 and no row for it.
- [ ] Posting the same feedback twice leaves one row per id.
- [ ] Migration applies on an empty database and on a database at the previous migration.

**Out of scope**
- Using feedback in ranking (that is the `recalls_30d_unused` input, a later issue).

**Depends on:** #1

**Branch:** `task/<issue-number>-j7` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J8 · server: switch embeddings to Qwen3-Embedding-0.6B with an index guard and a re-embed script  #12

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The embedding model changes from BGE-M3 to `Qwen/Qwen3-Embedding-0.6B`. Both are 1024-dimensional, so the column stays. Queries need an instruction prefix; documents do not (Spec 01 §3).

**Read first**
- docs/specs/01-memory-overlays.md §3 (last paragraph)
- `docs/specs/04-api-contract.md (Configuration)`
- the existing embedding repository in `server/` (search for `OPENKT_BGE_URL`)

**Do exactly this**
1. Add env `OPENKT_EMBED_URL` and `OPENKT_EMBED_MODEL` (default `Qwen/Qwen3-Embedding-0.6B`). Keep reading `OPENKT_BGE_URL` as a fallback for the URL and log one deprecation warning when it is used.
2. The embedding client gets a second parameter `kind: 'document' | 'query'`. For `query`, send the text prefixed with `Instruct: Given a question, retrieve team context that answers it\nQuery: `. For `document`, send the text unchanged. Update every caller: recall passes `query`, everything else passes `document`.
3. Call the OpenAI-compatible endpoint `POST ${url}/v1/embeddings` with `{ model, input: string[] }`. Assert each returned vector has length 1024; otherwise throw a typed error naming the model.
4. Add a table `index_meta(key text primary key, value text)` and on startup: if `embedding_model` is absent, write the configured model; if it differs and `OPENKT_ALLOW_REINDEX` is not `true`, refuse to start with a message that says exactly what to run.
5. Add a script `npm run reembed` that walks `memories` (and `page_sections` when that table exists) in batches of 64 ordered by id, embeds as `document`, updates the row, and at the end sets `index_meta.embedding_model`. It must be resumable (`--after <id>`) and print progress every 10 batches.
6. Expose the model id in `GET /v1/meta`.

**Files you may touch**
- the env schema
- the embedding repository/client
- its callers
- one migration for `index_meta`
- `server/scripts/reembed.ts`
- spec files

**Acceptance — every line must be true and tested**
- [ ] Unit test: `query` kind sends the prefixed text; `document` kind sends the text unchanged.
- [ ] Unit test: a 768-length vector from the endpoint throws the typed error.
- [ ] Startup with a mismatching `index_meta` fails with the instructive message; with `OPENKT_ALLOW_REINDEX=true` it starts.
- [ ] `reembed` run twice in a row changes nothing the second time except timestamps.
- [ ] No remaining reference to `bge` in code other than the deprecated env fallback.

**Out of scope**
- Hosting the model.
- Changing the vector column.

**Depends on:** #1

**Branch:** `task/<issue-number>-j8` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J9 · server: Postgres job queue (`jobs` table + worker loop)  #13

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Background work must not need a message broker (architecture §1). Spec 01 §3 defines the `jobs` table; Spec 02 §10 defines retry behaviour.

**Read first**
- docs/specs/01-memory-overlays.md §3 (`jobs`)
- docs/specs/02-agent-decisions.md §1 and §10
- the existing queue adapters in `server/` (search for `OPENKT_QUEUE_BACKEND`)

**Do exactly this**
1. Migration for `jobs` as specified, plus index `(status, run_after)`.
2. `JobQueue.enqueue(kind, payload, opts?: { dedupeKey?: string; runAfter?: Date })`: insert; on `dedupe_key` conflict do nothing and return the existing id.
3. `JobQueue.claim(kinds: string[])`: one statement — `UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= now() AND kind = ANY($1) ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
4. `complete(id)` → `done`. `fail(id, err)` → if `attempts < 6`: `queued` with `run_after = now() + (2^attempts) minutes`; else `failed`. Store `error` truncated to 2,000 chars.
5. A worker loop: claim → run the registered handler for `kind` → complete/fail; sleep 1 s when nothing was claimed; on shutdown finish the current job. Jobs stuck in `running` for more than 15 minutes are returned to `queued` by a sweep every minute.
6. Register it as the `postgres` value of `OPENKT_QUEUE_BACKEND` and make it the default.
7. `GET /v1/admin/jobs?status=` for workspace owners, newest first, without payloads larger than 2 KB (truncate).

**Files you may touch**
- one migration
- `server/**/queue/postgres-job-queue.service.ts`
- the worker bootstrap
- the env schema
- an admin controller
- spec files

**Acceptance — every line must be true and tested**
- [ ] Two workers claiming concurrently never receive the same job (integration test with two connections, 50 jobs).
- [ ] A handler that throws 6 times ends in `failed` with `attempts = 6`; delays double each time (assert `run_after`).
- [ ] Enqueueing twice with the same `dedupeKey` creates one row.
- [ ] A `running` job older than 15 minutes becomes `queued` again after the sweep.
- [ ] With `OPENKT_QUEUE_BACKEND` unset the server starts without RabbitMQ or SQS configured.

**Out of scope**
- Removing the SQS or RabbitMQ adapters.
- Writing any job handler.

**Depends on:** #1

**Branch:** `task/<issue-number>-j9` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J10 · server: `GET /v1/meta` and 404-instead-of-403 audit  #14

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Clients need to know what the server supports, and the API must not reveal that something exists to a user who cannot read it (Spec 04 conventions).

**Read first**
- `docs/specs/04-api-contract.md (top section and Operations)`

**Do exactly this**
1. Add `GET /v1/meta` (no auth) returning `{ version, embedding_model, rerank: boolean, features: string[] }`. `version` comes from `server/package.json`; `rerank` is true when `OPENKT_RERANK_URL` is set; `features` starts as `['sessions','grants','hybrid_recall']`.
2. Write an e2e test file that, as a user with no access, requests every `GET/PATCH/DELETE` route taking a session id, a project id, a memory id or a grant id, and asserts 404 with error code `not_found` — never 403.
3. Fix any route that returns 403 or leaks a different message.

**Files you may touch**
- a `meta.controller.ts`
- `server/test/e2e/no-existence-leak.e2e-spec.ts`
- only the controllers/services the test proves wrong

**Acceptance — every line must be true and tested**
- [ ] `/v1/meta` works without a token.
- [ ] The audit test lists every id-taking route (generate the list from the router, do not hand-pick) and passes.

**Depends on:** #1

**Branch:** `task/<issue-number>-j10` · **Rules:** `AGENTS.md`

### J11 · `docker compose up` for the whole stack  #15

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Anyone must be able to run OpenKT from a clean clone (PLAN.md, definition of done).

**Read first**
- docs/architecture.md §1
- `docs/specs/04-api-contract.md (Configuration)`

**Do exactly this**
1. Create `docker-compose.yml` with services: `db` (`pgvector/pgvector:pg16`, named volume, healthcheck `pg_isready`); `embed` (`ghcr.io/huggingface/text-embeddings-inference:cpu-latest`, `--model-id Qwen/Qwen3-Embedding-0.6B`, volume for the model cache); `rerank` (same image, `--model-id Qwen/Qwen3-Reranker-0.6B`) under the compose profile `rerank` so it is optional; `server` (built from `server/Dockerfile`, depends on `db` healthy, runs migrations then starts, env wired to the other services).
2. There is deliberately **no** language-model container: `OPENKT_LLM_BASE_URL` must be supplied by the user. Default it to `http://host.docker.internal:11434/v1` and document Ollama and LM Studio in the README section.
3. Create `.env.example` listing every variable from Spec 04 with a one-line comment each. No real values.
4. Add a `Quick start` section to the root `README.md`: clone → copy `.env.example` → `docker compose up` → `curl localhost:3000/v1/meta` → connect an MCP client.
5. Add `scripts/smoke.sh` that waits for `/healthz`, calls `/v1/meta`, and exits non-zero on failure.

**Files you may touch**
- `docker-compose.yml`
- `.env.example`
- README.md (Quick start section only)
- `scripts/smoke.sh`
- server/Dockerfile (only if it does not build in compose)

**Acceptance — every line must be true and tested**
- [ ] From a clean clone: `cp .env.example .env && docker compose up -d && ./scripts/smoke.sh` exits 0. Paste the output.
- [ ] `docker compose --profile rerank up -d` also starts the reranker and `/v1/meta` then reports `rerank: true`.
- [ ] No secret or personal hostname in any committed file.

**Out of scope**
- Kubernetes, Terraform, cloud deploys.
- GPU images.

**Depends on:** #1, #12

**Branch:** `task/<issue-number>-j11` · **Rules:** `AGENTS.md`

### J12 · Evaluation set: 50 questions with expected sources and access traps  #16

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Retrieval quality is the product. We judge every change against our own fixed set, not public benchmarks (Spec 01 §4 last bullet).

**Read first**
- `docs/product.md (Success measures)`
- docs/specs/01-memory-overlays.md §2 and §4
- `packages/agents/fixtures/ (for tone and domains)`

**Do exactly this**
1. Create `eval/dataset/world.json`: one workspace; 4 users (`ana`, `ravi`, `mei`, `sam`); 5 spaces (`sales-northgate`, `eng-auth`, `marketing-launch`, `ideas`, plus each user's personal space); grants such that: ana+ravi read `sales-northgate`, mei+ravi read `eng-auth`, everyone reads `ideas`, sam reads only `ideas` and sam's personal space.
2. Create `eval/dataset/sessions/*.json`: 24 sessions (6 per shared space) in the API shape of Spec 04, each with 8–30 realistic turns. Mix sources: claude-code, chatgpt, meeting, voice, note. Include 4 pairs where a later session contradicts an earlier one (for supersede), 3 sessions in Thai or Hindi, and 3 personal sessions that contain things no teammate should see.
3. Create `eval/dataset/questions.json`: 50 objects `{ id, asker, space?, question, expect: { any_of_sessions: string[] } | { nothing: true }, tags: string[] }`. Required mix: 25 direct, 8 paraphrased with no shared keywords, 5 cross-language, 4 supersede (expect the newer session only), 8 **access traps** where the answer exists but the asker cannot read it, so `expect.nothing` is true.
4. Create `eval/run.ts`: loads the world into a running server through the public API only, asks every question through `POST /v1/memories/recall`, and prints: recall@5, MRR, abstain accuracy, and **access-trap leaks (must be 0)**. Exit code 1 when any trap leaks.
5. Add `npm run eval:recall` at the root.

**Files you may touch**
- `eval/**`
- package.json (one script)

**Acceptance — every line must be true and tested**
- [ ] `questions.json` has exactly 50 entries with the stated mix (the runner asserts the counts).
- [ ] Every `any_of_sessions` id exists; every trap's asker truly lacks a grant (the runner asserts both before asking anything).
- [ ] Against a running v0.1 server the runner prints the four numbers and exits 1 if a trap leaks. Paste the output.
- [ ] No real people, companies or credentials in the dataset.

**Out of scope**
- Tuning the server to score well.

**Depends on:** #1

**Branch:** `task/<issue-number>-j12` · **Rules:** `AGENTS.md`

### J20 · pipeline: `chunkTurns()`  #17

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Sessions are cut into chunks before extraction (Spec 02 §2).

**Read first**
- docs/specs/02-agent-decisions.md §2
- `packages/pipeline/src/types.ts`

**Do exactly this**
1. Create `packages/pipeline/src/chunker.ts` exporting `chunkTurns(turns: Turn[], opts?: { maxChars?: number; overlapTurns?: number }): Chunk[]` with `Chunk = { index: number; turns: Turn[]; overlap: Turn[]; text: string }` and `shouldExtract(turns: Turn[]): boolean`.
2. Pre-clean each turn: drop turns with `role==='system'`; replace any fenced code block longer than 40 lines with `[code omitted: N lines, LANG]` (LANG from the fence, or `text`).
3. `shouldExtract` is false when the cleaned user+assistant+speaker+note text totals under 200 characters.
4. Pack turns in order into chunks of at most `maxChars` (default 6000) counting `content.length`; never split a turn unless that single turn exceeds `maxChars`, in which case split it on blank lines, then on sentence ends, into parts that fit, keeping `seq` and adding `part: n` in a new optional field.
5. Each chunk after the first gets `overlap` = the last `overlapTurns` (default 2) turns of the previous chunk.
6. `text` renders as: overlap turns under a line `[context — already processed]`, then a line `[new]`, then the chunk's turns, each as `SPEAKER: content` where SPEAKER is `speaker ?? role`.
7. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/chunker.ts`
- `packages/pipeline/test/chunker.test.ts`
- `packages/pipeline/src/index.ts`
- packages/pipeline/src/types.ts (add `part?: number` to Turn, nothing else)

**Acceptance — every line must be true and tested**
- [ ] 10 turns of 1,000 chars → 2 chunks (6 + 4); chunk 2 has 2 overlap turns; its text contains both marker lines.
- [ ] One 15,000-char turn → 3 parts, none over 6,000, concatenation of parts equals the original content.
- [ ] System turns never appear.
- [ ] A 60-line fenced ```ts block becomes `[code omitted: 60 lines, ts]`; a 10-line block is untouched.
- [ ] `shouldExtract` false at 199 chars, true at 200.
- [ ] Empty input → `[]`.
- [ ] typecheck and tests pass.

**Out of scope**
- Calling a model.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j20` · **Rules:** `AGENTS.md`

### J21 · pipeline: `quoteGate()`  #18

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** A fact whose supporting quote is not literally in the session is dropped (Spec 01 §5, Spec 02 §2 overlap rule).

**Read first**
- docs/specs/01-memory-overlays.md §5
- docs/specs/02-agent-decisions.md §2
- `packages/agents/src/text.ts (there is a normaliser there already — reuse its rules, do not import across packages; copy the function and its tests)`

**Do exactly this**
1. Create `packages/pipeline/src/quote-gate.ts` exporting `normalise(s: string): string` and `quoteGate(facts: ExtractedFact[], chunk: { turns: Turn[]; overlap: Turn[] }): { kept: (ExtractedFact & { turn_seq: number })[]; dropped: { index: number; reason: 'quote_not_found' | 'quote_only_in_overlap' | 'quote_too_short' | 'secret' }[] }`.
2. `normalise`: Unicode NFKC; curly quotes → straight; all whitespace runs → one space; trim; lowercase.
3. A quote shorter than 12 normalised characters → `quote_too_short`.
4. Search the normalised quote inside each normalised turn of `chunk.turns`; first hit sets `turn_seq`. Found only in `chunk.overlap` → `quote_only_in_overlap`. Not found → `quote_not_found`.
5. If `hasSecret(statement) || hasSecret(quote)` → `secret` (import from `./secrets.js`).
6. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/quote-gate.ts`
- `packages/pipeline/test/quote-gate.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] A quote differing only by curly quotes, case and double spaces is kept.
- [ ] A quote spanning two turns is dropped (`quote_not_found`).
- [ ] A quote present only in overlap is dropped with that reason.
- [ ] An 11-char quote is dropped; a 12-char one can pass.
- [ ] A fact containing a fake AWS key is dropped as `secret`.
- [ ] A Thai quote and a Hindi quote that appear verbatim are kept.
- [ ] typecheck and tests pass.

**Depends on:** #10

**Branch:** `task/<issue-number>-j21` · **Rules:** `AGENTS.md`

### J22 · pipeline: `capFacts()` and `mapKind()`  #19

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Per-chunk and per-session caps (Spec 02 §2) and the mapping from product kinds to the database enum (Spec 02 §7).

**Read first**
- docs/specs/02-agent-decisions.md §2 and §7
- `packages/pipeline/src/types.ts (`KIND_PRIORITY`)`

**Do exactly this**
1. `packages/pipeline/src/caps.ts`: `capFacts<T extends { kind: Kind }>(facts: T[], max: number): T[]` — if over `max`, keep by `KIND_PRIORITY` order, preserving original order within a kind, then return the kept items in their original relative order. Constants `MAX_FACTS_PER_CHUNK = 12`, `MAX_FACTS_PER_SESSION = 60`.
2. `packages/pipeline/src/kind-map.ts`: `mapKind(kind: Kind): { dbKind: 'decision'|'fact'|'pattern'|'incident'|'note'; extraTags: string[] }` per the Spec 02 §7 table, and the inverse `unmapKind(dbKind: string, tags: string[]): Kind` (unknown dbKind → `fact`).
3. Export both from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/caps.ts`
- `packages/pipeline/src/kind-map.ts`
- `packages/pipeline/test/caps.test.ts`
- `packages/pipeline/test/kind-map.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] 15 facts with 5 ideas and max 12 → 3 ideas removed, the *last* three ideas, order otherwise preserved.
- [ ] `mapKind('question')` → `{ dbKind:'note', extraTags:['open-question'] }`; all 7 kinds covered by a table test.
- [ ] `unmapKind(mapKind(k).dbKind, mapKind(k).extraTags) === k` for all 7 kinds.
- [ ] typecheck and tests pass.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j22` · **Rules:** `AGENTS.md`

### J23 · pipeline: `decideDuplicate()` and `guardSupersede()`  #20

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Most duplicate decisions are arithmetic; only the grey zone goes to a model (Spec 02 §3).

**Read first**
- docs/specs/02-agent-decisions.md §3
- `packages/pipeline/src/types.ts (`Neighbour`, `FactRef`)`

**Do exactly this**
1. `packages/pipeline/src/dedupe.ts`. Constants `DUP_AUTO = 0.97`, `DUP_ASK = 0.82`, `MAX_SUPERSEDES = 3`.
2. `decideDuplicate(neighbours: Neighbour[]): { action: 'duplicate'; of: string } | { action: 'ask_agent'; candidates: Neighbour[] } | { action: 'new' }`. Use the highest similarity; `ask_agent` candidates = neighbours with similarity ≥ 0.82, best first, max 10. Neighbours from another `project_id` than the first neighbour's are ignored entirely (defensive).
3. `guardSupersede(newFact: { kind: Kind; created_at: string; project_id: string; owner_user_id: string }, agentAnswer: { duplicate_of: string | null; supersedes: string[] }, candidates: Neighbour[]): { duplicate_of: string | null; supersedes: string[]; rejected: { id: string; reason: string }[] }` applying every guard in Spec 02 §3: unknown id; not older; other project; pinned or other author unless new kind ∈ {decision, fact, how-to}; more than 3 → reject all with reason `suspicious_supersede`. If `duplicate_of` is valid, `supersedes` is forced empty.
4. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/dedupe.ts`
- `packages/pipeline/test/dedupe.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] 0.97 → duplicate; 0.9699 → ask_agent; 0.82 → ask_agent; 0.8199 → new; no neighbours → new.
- [ ] ask_agent never returns more than 10 and never one below 0.82.
- [ ] Each guard has a test that names its `reason`.
- [ ] 4 supersedes → all rejected as `suspicious_supersede`.
- [ ] A `question` cannot supersede another author's fact; a `decision` can.
- [ ] typecheck and tests pass.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j23` · **Rules:** `AGENTS.md`

### J24 · pipeline: `normaliseTags()` with vocabulary convergence  #21

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Tags must converge on the team's own words (Spec 02 §4).

**Read first**
- docs/specs/02-agent-decisions.md §4

**Do exactly this**
1. `packages/pipeline/src/tags.ts`: `slugTag(raw: string): string | null` — NFKD, strip diacritics, lowercase, non-alphanumerics → `-`, collapse and trim dashes, cut to 32 chars (then trim a trailing dash). Return null when the result is empty or is exactly one of the 7 kind names (`decision`, `fact`, `how-to`, `issue`, `question`, `action`, `idea`). Nothing else is rejected.
2. `normaliseTags(proposed: string[], vocab: { tag: string; count: number }[], similarity: (a: string, b: string) => number): { tags: string[]; created: string[] }` — slug each; if the slug is in vocab keep it; else find the vocab tag with the highest `similarity(slug, tag)`; if ≥ 0.85 replace with it; else keep as new and list it in `created`. De-duplicate, keep first 4.
3. `similarity` is injected so the function stays pure; tests pass a fake.
4. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/tags.ts`
- `packages/pipeline/test/tags.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] `'Northgate Pricing!'` → `northgate-pricing`; `'Décision'` → null (it is a kind name after folding); `''` → null.
- [ ] With vocab `[customer-northgate]` and a fake similarity of 0.9 between `northgate` and it → output is `customer-northgate`, `created` is empty.
- [ ] Similarity 0.84 → new tag kept and listed in `created`.
- [ ] 6 proposed → 4 returned, no duplicates.
- [ ] A 50-char tag is cut to 32 without a trailing dash.
- [ ] typecheck and tests pass.

**Out of scope**
- Computing embeddings.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j24` · **Rules:** `AGENTS.md`

### J25 · pipeline: `guardRoutes()`  #22

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The `route` agent proposes where each fact goes; code enforces the rules (Spec 02 §5 step 3).

**Read first**
- docs/specs/02-agent-decisions.md §5
- `packages/agents/schemas/route.json (the agent's output shape — read only)`

**Do exactly this**
1. `packages/pipeline/src/route-guards.ts` exporting `guardRoutes(input: { facts: (FactRef & { age_days: number })[]; proposals: Proposal[]; pages: { id: string; sections: { heading: string; locked: boolean }[] }[]; unroutedTitles: string[]; titleSimilarity: (a: string, b: string) => number }): { routes: Route[]; unrouted: { fact_id: string; reason: string }[] }`. `Proposal = { fact_id, action: 'append'|'rewrite_section'|'new_page'|'noop', page_id?, section_title?, new_page_title? }`. `Route` is the same without `noop`, plus `redirected_from_locked?: boolean`.
2. Rules, in this order: unknown `fact_id` → ignore. `confidence < 0.4` → unrouted `low_confidence`. kind `action` or `question` with `age_days > 30` → unrouted `stale`. `append`/`rewrite_section` with unknown `page_id` → unrouted `unknown_page`. Unknown `section_title` on a known page → treat as `append` to a new section with that heading. Target section `locked` → change to `append` on heading `Updates`, set `redirected_from_locked`. `new_page`: title must be ≤ 60 chars, contain ` — `, and not end with `.`, `?` or `!`, else unrouted `bad_title`.
3. `new_page` titles with `titleSimilarity ≥ 0.85` are merged into the first one seen. A `new_page` group is allowed when it has ≥ 3 facts (counting entries of `unroutedTitles` equal or similar ≥ 0.85) **or** any fact in it has kind `decision`; otherwise its facts are unrouted `waiting_for_more`.
4. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/route-guards.ts`
- `packages/pipeline/test/route-guards.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] One test per rule, asserting the exact `reason` string.
- [ ] Two facts proposing `Northgate — pricing` and `Northgate — Pricing` end up on one new page.
- [ ] A single `fact`-kind proposal for a new page is `waiting_for_more`; the same with kind `decision` is routed.
- [ ] A locked target becomes `Updates` with the flag set.
- [ ] typecheck and tests pass.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j25` · **Rules:** `AGENTS.md`

### J26 · pipeline: `validateSection()` and `fallbackAppend()`  #23

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** What the `write_section` agent returns is checked by code, and a deterministic fallback guarantees the page still updates (Spec 02 §6).

**Read first**
- docs/specs/02-agent-decisions.md §6
- docs/specs/01-memory-overlays.md §5 (page limits)

**Do exactly this**
1. `packages/pipeline/src/section.ts`. `parseCitations(md: string): string[]` returns the uuids inside `[^f:<uuid>]` markers in order of appearance.
2. `validateSection(md: string, ctx: { inputFactIds: string[]; existingFactIds: string[]; maxChars?: number }): { ok: true } | { ok: false; errors: string[] }` — errors (collect all, do not stop at the first): `too_long` (> 1200); `uncited_sentence` when any sentence (split on `. `, `? `, `! `, newline; ignore headings and empty lines; bullet lines count as sentences) has no citation before its end; `missing_fact:<id>` for each input id not cited; `unknown_citation:<id>` for each cited id in neither list.
3. `fallbackAppend(currentMd: string, facts: { id: string; statement: string }[]): string` — append one line per fact: `- <statement> [^f:<id>]`. Statements are trimmed and a trailing period is removed before the citation. Do not enforce the length limit here; the lint job splits long sections.
4. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/section.ts`
- `packages/pipeline/test/section.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] A valid two-sentence section with both facts cited → ok.
- [ ] Each of the four error types is produced by a dedicated test; one test produces two errors at once.
- [ ] `fallbackAppend` output always passes `validateSection` when under the length limit.
- [ ] Citations with uppercase UUIDs are accepted and compared case-insensitively.
- [ ] typecheck and tests pass.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j26` · **Rules:** `AGENTS.md`

### J27 · pipeline: `assignConfidence()`  #24

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Confidence is computed from how a fact was obtained, never asked from a model (Spec 02 §8).

**Read first**
- docs/specs/02-agent-decisions.md §8

**Do exactly this**
1. `packages/pipeline/src/confidence.ts` exporting `assignConfidence(input: { origin: 'explicit_save' | 'extracted'; source: string; quoteTurnRole?: TurnRole; contradictedLater?: boolean; speakerKnown?: boolean; quoteFrom?: 'transcript' | 'image_description' | 'ocr' }): number` and `bumpOnConfirmation(current: number): number` (+0.10, cap 0.95) and `MARKED_WRONG = 0.10`.
2. Follow the Spec 02 §8 table exactly. `extracted` + assistant role + `contradictedLater` true → 0.30 (the table implies lower than 0.55; this value is decided here). Meeting with `speakerKnown === false` → 0.50. Anything not covered → 0.50.
3. Export from `src/index.ts`.

**Files you may touch**
- `packages/pipeline/src/confidence.ts`
- `packages/pipeline/test/confidence.test.ts`
- `packages/pipeline/src/index.ts`

**Acceptance — every line must be true and tested**
- [ ] A table test with one row per line of the Spec 02 §8 table plus the two extra rules above.
- [ ] `bumpOnConfirmation(0.9)` → 0.95; `(0.95)` → 0.95.
- [ ] typecheck and tests pass.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j27` · **Rules:** `AGENTS.md`

### J30 · server: migrations and schema for pages, sections, revisions, briefs, attachments, connector defaults  #25

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The tables of tiers T2 and T3 (Spec 01 §3).

**Read first**
- docs/specs/01-memory-overlays.md §3
- `server/WHERE_THINGS_LIVE.md`
- an existing migration + schema pair in `server/` as a style reference

**Do exactly this**
1. One migration adding: `pages`, `page_sections` (with `embedding vector(1024)`, generated `tsv` using the `simple` config, GIN index on `tsv`, HNSW index on `embedding` with `vector_cosine_ops`), `page_section_facts`, `page_revisions`, `briefs`, `attachments`, `connector_defaults`, and the columns `memories.quote`, `memories.valid_from`, `memories.valid_to`, `projects.shared_with_workspace`. Skip any column that already exists (`ADD COLUMN IF NOT EXISTS`).
2. Foreign keys cascade on delete from `pages` to its children and from `sessions` to `attachments`; `page_section_facts.memory_id` cascades too.
3. Drizzle schema files for each table, exported from the schema index. Match the column names exactly.
4. Append the journal entry with a `when` larger than every existing one.

**Files you may touch**
- one migration file
- schema files under `server/**/db/schema/`
- the schema index
- the migrations journal

**Acceptance — every line must be true and tested**
- [ ] Applies on an empty database and on a database at the previous migration; applying twice is a no-op.
- [ ] `\d page_sections` shows both indexes.
- [ ] TypeScript compiles; the schema test that loads every table passes.

**Out of scope**
- Any service or endpoint.

**Depends on:** #1

**Branch:** `task/<issue-number>-j30` · **Rules:** `AGENTS.md`

### J31 · server: job handlers J1–J4 (summarise, extract, embed, classify)  #26

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Wire the first half of the write pipeline (Spec 02 §1). All decisions already exist as pure functions in `@openkt/pipeline` and all model calls as agents in `@openkt/agents`. Your code only moves data between them and the database.

**Read first**
- docs/specs/02-agent-decisions.md §1–§4, §8–§10
- `packages/pipeline/README.md`
- `packages/agents/README.md`
- the job queue from the `jobs` issue

**Do exactly this**
1. On `POST /v1/sessions/:id/close`, enqueue `summarise_session` and `extract_session` with `dedupe_key = '<kind>:<session_id>'`.
2. `summarise_session`: load turns → `summarise` agent → write `title` (only if empty) and `summary` on the session.
3. `extract_session`: `shouldExtract` → `chunkTurns` → per chunk: `extract` agent → `quoteGate` → `capFacts(…, 12)`; after all chunks `capFacts(…, 60)`; insert each kept fact into `memories` with `session_id`, `source`, `quote`, `visibility` from the session's connector default (`personal` when none), `kind` via `mapKind`, `confidence` via `assignConfidence`; then enqueue `embed_fact` per fact. Record `{ facts, dropped_by_reason }` in `sessions.metadata.extraction`.
4. `embed_fact`: embed as `document`, store, enqueue `classify_fact`.
5. `classify_fact`: load the project's top-60 tag vocabulary → `tag` agent → `normaliseTags` (similarity = cosine of tag embeddings, cached in memory) → write tags. Then nearest-10 neighbours in the same project → `decideDuplicate` → if `ask_agent`: `dedupe` agent → `guardSupersede` → apply. A duplicate deletes the new row and appends the session id to the existing fact's `source_refs.also_seen_in`.
6. When the last `classify_fact` of a session completes, enqueue `route_facts` with `dedupe_key = 'route:<session_id>'`.
7. Every agent run writes one `llm_calls` row (Spec 02 §11).

**Files you may touch**
- `server/**/pipeline/*.handler.ts` (one file per job kind)
- the sessions close service
- spec files with the agents mocked

**Acceptance — every line must be true and tested**
- [ ] Closing a fixture session with a scripted fake LLM produces the expected facts, tags and supersede links (integration test).
- [ ] Running every job twice leaves the same rows (idempotency test).
- [ ] A fact with a fabricated quote is not inserted and is counted in `metadata.extraction`.
- [ ] An LLM timeout re-queues the job; the session is never left half-written (facts from completed chunks are kept, the failed chunk is retried alone).
- [ ] No handler contains a threshold number — they all come from `@openkt/pipeline`.

**Out of scope**
- Routing and pages (next issue).
- Changing prompts.

**Depends on:** #13, #17, #18, #19, #20, #21, #24, #25

**Branch:** `task/<issue-number>-j31` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J32 · server: job handlers J5–J8 (route, write section, brief, lint)  #27

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The second half of the write pipeline (Spec 02 §1, §5, §6; Spec 01 §5).

**Read first**
- docs/specs/02-agent-decisions.md §5–§6
- docs/specs/01-memory-overlays.md §5

**Do exactly this**
1. `route_facts`: take the session's surviving facts with visibility ≠ `personal` → candidate pages per Spec 02 §5 step 1 → `route` agent → `guardRoutes` → group by `(page, section)` → create missing pages/sections → enqueue one `write_section` per group. For each unrouted fact store the reason in `memories.source_refs.unrouted_reason`.
2. `write_section`: skip if the section is `locked` (should not happen after guards; assert). Call the `write_section` agent with the instruction line for `append` or `rewrite_section` → `validateSection`; on failure retry once with the errors appended; on second failure use `fallbackAppend`. In one transaction: update `body_md`, replace the section's `page_section_facts`, bump `pages.version`, insert `page_revisions` (`actor = 'agent:write_section'`), set `pages.summary` = first 240 chars of the first section with citations stripped. Then re-embed the section and enqueue `refresh_brief` with `run_after = now() + 10 min` and `dedupe_key = 'brief:<project_id>'`.
3. `refresh_brief`: hash the page summaries; unchanged → done; else `brief` agent (1,500-char budget) → upsert `briefs`.
4. `lint_pages` (nightly): split a page with more than 8 sections into two pages at the midpoint (second page titled `<title> (2)` until a human renames it); split a section over 1,200 chars at the nearest sentence boundary to the middle; archive pages whose every cited fact is archived or superseded.
5. `kt_session_start` and `GET /v1/projects/:id/brief` return the stored brief.

**Files you may touch**
- `server/**/pipeline/*.handler.ts`
- page and brief repositories
- spec files with agents mocked

**Acceptance — every line must be true and tested**
- [ ] Two sessions about the same customer produce one page, not two (integration test with a scripted LLM).
- [ ] A personal fact never appears in any `page_section_facts` row.
- [ ] Invalid agent output twice → the section still gains the facts through the fallback, and a revision row says so in `reason`.
- [ ] A human-locked section is unchanged after routing new facts to it; an `Updates` section appears.
- [ ] Ten page changes within ten minutes cause one brief regeneration.

**Out of scope**
- Page editing endpoints (next issue).

**Depends on:** #26, #22, #23

**Branch:** `task/<issue-number>-j32` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J33 · server: pages and briefs REST API + `kt_page` tool  #28

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** People and tools read and correct the knowledge base (Spec 04, Spaces/pages/briefs).

**Read first**
- `docs/specs/04-api-contract.md`
- docs/specs/01-memory-overlays.md §5 (humans win)

**Do exactly this**
1. Implement `GET /v1/projects/:id/pages`, `GET /v1/pages/:id`, `PUT /v1/pages/:id/sections/:sid`, `GET /v1/pages/:id/revisions`, `POST /v1/pages/:id/revisions/:v/restore`, `GET /v1/projects/:id/brief` exactly as in Spec 04.
2. `GET /v1/pages/:id` builds `sources` by numbering the distinct sessions of all cited facts in order of first citation, and rewrites `[^f:<uuid>]` to `[^n]` in the returned markdown while also returning a map `{ n → session }`. Sessions the caller cannot read appear as `{ n, restricted: true }` without title or author.
3. `PUT section` requires `editor`; sets `locked = true`, writes a revision with `actor = 'user:<id>'`, re-embeds.
4. `reach` = distinct sessions and people in `recall_events` of the last 7 days whose `returned` includes one of the page's sections.
5. MCP tool `kt_page` returns the same page as markdown.

**Files you may touch**
- `server/**/pages/*.controller.ts`, `*.service.ts`, contracts
- the MCP server factory
- spec + e2e files

**Acceptance — every line must be true and tested**
- [ ] Someone with no access to the space gets 404 on every page route. A reader calling `PUT section` gets 403 `insufficient_role` (they can already see the page, so nothing leaks). Test both.
- [ ] Restoring revision 2 of 5 creates revision 6 equal to 2.
- [ ] A restricted source never leaks its title.
- [ ] After a human edit, the write pipeline leaves that section alone (reuse the fixture from the previous issue).

**Depends on:** #27

**Branch:** `task/<issue-number>-j33` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J34 · server: register the MCP Apps cards  #29

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The card bundle exists in `packages/mcp-cards`. The server must expose it and the card tools (Spec 04, card tools table).

**Read first**
- `packages/mcp-cards/server-integration.md`
- `docs/specs/04-api-contract.md (card tools)`

**Do exactly this**
1. Serve the built bundle as the MCP resource `ui://openkt/cards.html` with MIME `text/html;profile=mcp-app`.
2. Register `kt_save_card`, `kt_search_card`, `kt_session_card` with `_meta.ui.resourceUri`, returning text **and** the `structuredContent` shapes in Spec 04.
3. Register `kt_commit_save` and `kt_mark_used` with `visibility: ['app']`.
4. Register the five card tools only when the client advertised the `io.modelcontextprotocol/ui` extension; otherwise they must not appear in `tools/list`.
5. `kt_save_card.spaces` lists only spaces where the caller is editor or owner, plus `Only me`.

**Files you may touch**
- the MCP server factory and a new `mcp-cards.service.ts`
- spec files

**Acceptance — every line must be true and tested**
- [ ] `tools/list` without the extension → no card tools; with it → five more.
- [ ] `kt_commit_save` cannot be called by a client that lists tools as a model (it is absent from the model-visible list).
- [ ] A space where the caller is only a reader never appears in `spaces`.
- [ ] The preview harness in `packages/mcp-cards` renders the server's real `structuredContent` for all three views (paste screenshots).

**Out of scope**
- Changing the card bundle.

**Depends on:** #1

**Branch:** `task/<issue-number>-j34` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J35 · server: connector defaults API  #30

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Each tool has a default space and access for the sessions it produces (product.md, Connector).

**Read first**
- `docs/specs/04-api-contract.md (Access)`
- docs/specs/01-memory-overlays.md §3 (`connector_defaults`)

**Do exactly this**
1. `GET /v1/me/connector-defaults` → one entry per known source with the stored default or `{ project_id: null, grant_template: [] }`.
2. `PUT /v1/me/connector-defaults/:source` validates: `project_id` must be writable by the caller; every `subject_id` in `grant_template` must be a member of the same workspace; roles are `reader|editor`.
3. `POST /v1/sessions` applies the default when `project_id` is absent: file into that project and create the template's grants on the new session.

**Files you may touch**
- a `connector-defaults` controller/service/contract
- the sessions create service
- spec files

**Acceptance — every line must be true and tested**
- [ ] A session created with source `chatgpt` and no project lands in the configured space with the template grants.
- [ ] No default → personal space, no grants.
- [ ] A default pointing at a space the user can no longer write to falls back to personal and the response includes `default_ignored: true`.

**Depends on:** #25

**Branch:** `task/<issue-number>-j35` · **Rules:** `AGENTS.md`

### J40 · desktop: implement the `http` API adapter against Spec 04  #31

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The app ships with a `mock` adapter and a thin, untested `http` one. Make `http` real.

**Read first**
- `docs/specs/04-api-contract.md`
- apps/desktop/src/api/client.ts and types.ts
- `apps/desktop/src/api/mock/index.ts (behaviour to match)`

**Do exactly this**
1. Implement every method of the `ApiClient` interface in `src/api/http.ts` with `fetch`, mapping server words to app words at this edge only (`project`→space, `memory`→context item).
2. Bearer token and base URL come from the settings store. 401 → emit a `signed-out` event. 404/403/409/422 → typed errors carrying the server's `error.code`.
3. Cursor pagination helpers for lists.
4. Add `msw` (dev dependency, allowed for this issue) and write tests that run the same behavioural suite against both adapters.

**Files you may touch**
- `apps/desktop/src/api/http.ts`
- `apps/desktop/src/api/errors.ts`
- `apps/desktop/test/api/*.test.ts`
- apps/desktop/package.json (msw only)

**Acceptance — every line must be true and tested**
- [ ] One shared test suite passes for `mock` and for `http`+msw.
- [ ] A 401 triggers exactly one `signed-out` event.
- [ ] No component imports `http.ts` directly — only through `src/api/index.ts`.
- [ ] typecheck, tests and build pass.

**Out of scope**
- UI changes.

**Depends on:** #1

**Branch:** `task/<issue-number>-j40` · **Rules:** `AGENTS.md`

### J41 · desktop: connect tools from the app (write each tool's MCP config)  #32

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Zero-terminal setup: the onboarding step "Connect your tools" must actually wire them (product.md).

**Read first**
- `plugin/skills/openkt/references/ (per-client setup, the source of truth for file paths and shapes)`
- `apps/desktop/src/main/ (IPC pattern)`
- `design/canvas/Onboarding.dc.html`

**Do exactly this**
1. In the main process add `tools/` with one module per client: detect (does its config dir exist), read current config, `plan()` returning the exact diff, `apply()` writing it with a timestamped backup next to the file. Clients: Claude Code, Claude Desktop, Cursor, Codex, VS Code. Shapes come from the references folder — do not guess.
2. Tokens go to the macOS Keychain through Electron `safeStorage`; config files reference the server URL and, where the client supports OAuth, no token at all.
3. The renderer shows the plan (file path + what will be added) before applying, and the result per tool after.
4. `undo` restores the backup.

**Files you may touch**
- `apps/desktop/src/main/tools/*.ts`
- `apps/desktop/src/shared/ipc.ts`
- the onboarding and connectors screens
- tests using a temp HOME

**Acceptance — every line must be true and tested**
- [ ] With a temp HOME containing fake config dirs, `plan()` then `apply()` produce the expected files (snapshot tests) and leave unrelated keys untouched.
- [ ] Applying twice is a no-op.
- [ ] `undo` restores byte-identical originals.
- [ ] A malformed existing config is never overwritten: the tool is reported as `needs attention` with the parse error.

**Out of scope**
- Hooks.
- Windows and Linux paths.

**Depends on:** #3

**Branch:** `task/<issue-number>-j41` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J42 · desktop: page view editing and revision history  #33

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** People can correct a living page and their edit wins (Spec 01 §5).

**Read first**
- design/canvas/Page.dc.html and the page-editing artboard from the canvas issue
- `docs/specs/04-api-contract.md (pages)`

**Do exactly this**
1. Section-level edit: click Edit → the section becomes a plain textarea with markdown; Save calls `PUT section`; the section shows a small `edited by you` marker.
2. A History panel lists revisions with actor and time; Restore calls the restore endpoint after a confirm.
3. Citations render as superscript numbers linked to the sources rail; a restricted source shows `Restricted session`.

**Files you may touch**
- `apps/desktop/src/screens/page/*`
- mock adapter additions
- `tests`

**Acceptance — every line must be true and tested**
- [ ] Matches the artboard (attach screenshots at 1280×800).
- [ ] Editing, saving and restoring work against the mock adapter in tests.
- [ ] Keyboard: Esc cancels, ⌘↵ saves.

**Out of scope**
- Rich-text editing.

**Depends on:** #3, #28

**Branch:** `task/<issue-number>-j42` · **Rules:** `AGENTS.md`

### J43 · desktop: macOS packaging, signing placeholders and auto-update wiring  #34

`junior` `needs-mac`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Release plumbing, no product logic.

**Read first**
- `apps/desktop/electron-builder.yml`

**Do exactly this**
1. GitHub Actions workflow on `macos-14`: install, typecheck, test, `electron-builder --mac dmg zip` for arm64. Signing and notarisation read from secrets and are skipped with a clear log line when the secrets are absent.
2. Wire `electron-updater` against GitHub Releases, checking at start and every 6 hours; never auto-install without the user clicking Restart.

**Files you may touch**
- `.github/workflows/desktop.yml`
- `apps/desktop/src/main/updater.ts`
- `apps/desktop/electron-builder.yml`

**Acceptance — every line must be true and tested**
- [ ] The workflow produces an unsigned arm64 dmg artifact on a pull request.
- [ ] With no update feed reachable the app starts normally and logs one line.

**Out of scope**
- Buying certificates.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j43` · **Rules:** `AGENTS.md`

---

## Version 0.4 A function key away

| Task | Who | Title | Depends on |
|---|---|---|---|
| #35 J50 | junior | engine: Swift package skeleton and the stdio JSON protocol loop | — |
| #36 J51 | junior | engine: model manager (download, verify, load/unload policy) | #35 |
| #37 J52 | junior | engine: `agent.run` with guided generation, and `embed` with the parity test | #36, #4 |
| #38 J53 | junior | engine: global hotkeys and the voice pipeline | #36 |
| #39 J54 | junior | engine: screenshot capture, OCR and image understanding | #37 |


### J50 · engine: Swift package skeleton and the stdio JSON protocol loop  #35

`junior` `needs-mac`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The capture engine is a Swift helper the Electron app talks to over newline-delimited JSON (Spec 03 §6).

**Read first**
- docs/specs/03-vision-and-speech.md §6
- `apps/desktop/src/main/engine/protocol.ts (the TypeScript side of the same messages)`

**Do exactly this**
1. Create `apps/desktop/engine/` as a Swift package with an executable target `openkt-engine`, macOS 15+, Swift 6.
2. Codable types for every message in Spec 03 §6. Read stdin line by line, dispatch by `type`, write one JSON line per reply to stdout; logs go to stderr only.
3. Implement for real: `models.status` (returns the five jobs as `absent`). Every other request type replies `{ id, error: { code: 'not_implemented' } }`.
4. Unknown `type` or malformed JSON → an error reply, never a crash. EOF on stdin → clean exit 0.

**Files you may touch**
- `apps/desktop/engine/Package.swift`
- `apps/desktop/engine/Sources/**`
- `apps/desktop/engine/Tests/**`

**Acceptance — every line must be true and tested**
- [ ] `swift test` passes, including a test that pipes 1,000 mixed valid/invalid lines through the loop and gets exactly 1,000 replies in order.
- [ ] `echo '{"id":"1","type":"models.status"}' | swift run openkt-engine` prints one valid JSON line.
- [ ] Nothing but protocol JSON is ever written to stdout.

**Out of scope**
- Any model or audio code.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j50` · **Rules:** `AGENTS.md`

### J51 · engine: model manager (download, verify, load/unload policy)  #36

`junior` `needs-mac` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Models are fetched on first use and unloaded when idle (Spec 03 §2).

**Read first**
- docs/specs/03-vision-and-speech.md §2

**Do exactly this**
1. A manifest `models.json`: job → Hugging Face repo id, revision (pinned commit), files, sha256, size.
2. `models.ensure` downloads to `~/Library/Application Support/OpenKT/models/<repo>/<revision>/` with resume, verifies sha256, emits progress events at most 4 per second.
3. A `ModelProvider` protocol with `load()`, `unload()`, `isLoaded`; an idle timer per provider using the durations in Spec 03 §2; a memory policy that refuses to co-load meeting ASR and the language model when physical memory ≤ 8 GB.

**Files you may touch**
- `apps/desktop/engine/Sources/Models/**`
- tests with a local HTTP server fixture

**Acceptance — every line must be true and tested**
- [ ] An interrupted download resumes from the byte it stopped at.
- [ ] A wrong sha256 deletes the file and reports `checksum_mismatch`.
- [ ] The 8 GB policy is unit-tested with an injected memory size.

**Out of scope**
- Running inference.

**Depends on:** #35

**Branch:** `task/<issue-number>-j51` · **Rules:** `AGENTS.md`

### J52 · engine: `agent.run` with guided generation, and `embed` with the parity test  #37

`junior` `needs-senior-review` `needs-mac` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** All eight agents run locally from the same prompt and schema files as the server (Spec 03 §6, Spec 02).

**Read first**
- docs/specs/03-vision-and-speech.md §2 and §6
- `packages/agents/README.md`

**Do exactly this**
1. Bundle `packages/agents/prompts/*.md` and `schemas/*.json` as resources (build script copies them; never edit copies).
2. `agent.run`: render the prompt, run Qwen3.5-4B through `mlx-swift-lm` with thinking disabled and JSON-Schema guided generation, validate, retry once, then return the agent's documented no-op.
3. `embed`: Qwen3-Embedding-0.6B, last-token pooling, L2 normalise, query prefix per Spec 01 §3.
4. Golden-vector test: 20 fixed strings (English, Thai, Hindi, code) whose reference vectors are committed from the server's TEI output; cosine ≥ 0.999 each.

**Files you may touch**
- `apps/desktop/engine/Sources/Agents/**`
- `apps/desktop/engine/Sources/Embed/**`
- `apps/desktop/engine/Tests/**`
- `apps/desktop/scripts/copy-agent-contract.mjs`

**Acceptance — every line must be true and tested**
- [ ] Every fixture in `packages/agents/fixtures/extract` yields schema-valid JSON locally.
- [ ] The golden-vector test passes; if it cannot, the pull request says which pooling or prefix detail differs — do not lower the threshold.

**Out of scope**
- Prompt changes.

**Depends on:** #36, #4

**Branch:** `task/<issue-number>-j52` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J53 · engine: global hotkeys and the voice pipeline  #38

`junior` `needs-mac` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Hold `fn` to talk (Spec 03 §3).

**Read first**
- docs/specs/03-vision-and-speech.md §3
- `design/canvas/Capture-Voice.dc.html`

**Do exactly this**
1. An event tap for `fn` hold and double-tap, and one configurable screenshot key; emits `hotkey` events. Requests Accessibility permission with a clear explanation.
2. `voice.start/stop`: microphone → Silero VAD → streaming ASR from `speech-swift` → `voice.partial` events → final non-streaming decode on stop.
3. Cleanup in code only (filler list, repeats). No model rewriting.
4. Clips under 1.5 s or without speech return `{ empty: true }`.

**Files you may touch**
- `apps/desktop/engine/Sources/Hotkeys/**`
- `apps/desktop/engine/Sources/Voice/**`
- tests with recorded WAV fixtures

**Acceptance — every line must be true and tested**
- [ ] A 15 s fixture transcribes with the expected text (allow small word error; assert key phrases).
- [ ] `fn` down → first partial within the Spec 03 §7 budget on an M-series Mac (log the measurement).
- [ ] Audio files are deleted after stop unless `keepAudio` is set.

**Out of scope**
- Meeting capture.

**Depends on:** #36

**Branch:** `task/<issue-number>-j53` · **Rules:** `AGENTS.md`

### J54 · engine: screenshot capture, OCR and image understanding  #39

`junior` `needs-mac` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Spec 03 §4.

**Read first**
- docs/specs/03-vision-and-speech.md §4
- `design/canvas/Capture-Screenshot.dc.html`

**Do exactly this**
1. `screenshot.capture` (region, window, or a given file path) through ScreenCaptureKit; Screen Recording permission flow.
2. Apple Vision OCR → `visible_text` with line boxes.
3. Resize to ≤ 1280 px long edge → `describe_image` agent with the OCR text included.
4. Apply the two drop rules of Spec 03 §4 (generic description with < 20 OCR chars; numbers not present in OCR).

**Files you may touch**
- `apps/desktop/engine/Sources/Screenshot/**`
- tests with PNG fixtures

**Acceptance — every line must be true and tested**
- [ ] Fixture images (a pricing page, a chart, a blank desktop) give: useful description, useful description, nothing saved.
- [ ] A number that appears only in the model's description is removed from extracted facts.

**Depends on:** #37

**Branch:** `task/<issue-number>-j54` · **Rules:** `AGENTS.md`

---

## Version 0.5 Meetings

| Task | Who | Title | Depends on |
|---|---|---|---|
| #40 J60 | junior | engine: meeting detection, two-channel capture and transcript merge | #38 |


### J60 · engine: meeting detection, two-channel capture and transcript merge  #40

`junior` `needs-senior-review` `needs-mac` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Spec 03 §5. Never records without the user pressing Record.

**Read first**
- docs/specs/03-vision-and-speech.md §5
- `design/canvas/Capture-Meeting.dc.html`

**Do exactly this**
1. Detect a known meeting app holding the microphone → `meeting.detected` event.
2. `meeting.start`: microphone and system audio as two separate streams; echo cancellation on the microphone; VAD and ASR per channel in 30 s windows with 2 s overlap; Sortformer on the system channel only.
3. Merge by timestamp into turns (`me`, `speaker_1…n`); de-duplicate text repeated by window overlap.
4. `meeting.stop` returns the full turn list; chunking by 5-minute windows cut at silence.

**Files you may touch**
- `apps/desktop/engine/Sources/Meeting/**`
- tests with a two-channel WAV fixture

**Acceptance — every line must be true and tested**
- [ ] The fixture yields alternating `me`/`speaker_1` turns in the right order with no duplicated overlap text.
- [ ] Nothing is captured before `meeting.start`.
- [ ] A 60-minute synthetic input finishes within the Spec 03 §7 budget (log it).

**Out of scope**
- Calendar lookup.

**Depends on:** #38

**Branch:** `task/<issue-number>-j60` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

---

## Version 0.6 Your other tools

| Task | Who | Title | Depends on |
|---|---|---|---|
| #41 J70 | junior | providers: types, registry and the `local` provider | — |
| #42 J71 | junior | providers: Composio plugin (bring your own API key) | #41 |
| #43 J72 | junior | connectors: interface + Obsidian (local vault) | #41 |
| #44 J73 | junior | connectors: Notion, Google Drive, Linear, Gmail `toSession` + list/backfill/poll | #43 |
| #45 J74 | junior | server + app: connector setup flow and the poll job | #42, #44, #26, #3 |


### J70 · providers: types, registry and the `local` provider  #41

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Spec 05 §2.

**Read first**
- `docs/specs/05-tool-providers.md`

**Do exactly this**
1. Create `packages/providers` (copy the package scaffold of `packages/recall`). Put the `ToolProvider` interface from Spec 05 §2 in `src/types.ts` verbatim.
2. `src/registry.ts`: `register(provider)`, `get(id)`, `list()`; duplicate id throws.
3. `src/local.ts`: provider `local` with actions `fs.list { dir }` and `fs.read { path }`, confined to a root directory given in config; any path escaping the root (`..`, symlink) throws `InvalidInputError`.

**Files you may touch**
- `packages/providers/**`

**Acceptance — every line must be true and tested**
- [ ] Path-escape attempts (`../`, absolute path, symlink out of root) are all rejected in tests using a temp dir.
- [ ] typecheck and tests pass.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j70` · **Rules:** `AGENTS.md`

### J71 · providers: Composio plugin (bring your own API key)  #42

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Composio is the first hosted provider, behind the same interface (Spec 05 §2). Teams paste their own key.

**Read first**
- docs/specs/05-tool-providers.md §2
- Composio's current SDK README (link it in the pull request)

**Do exactly this**
1. `packages/providers/src/composio.ts` implementing `ToolProvider` with the official `@composio/core` SDK (the one dependency allowed here).
2. `configSchema = { apiKey: string }`. `beginConnect` returns Composio's hosted connect link. `getConnection` maps Composio's status to `pending|active|error`. `call` executes an action. `subscribe` creates a trigger when available, else is left undefined.
3. All network access goes through one injectable client so tests need no key.

**Files you may touch**
- `packages/providers/src/composio.ts`
- `packages/providers/test/composio.test.ts`
- `packages/providers/package.json`

**Acceptance — every line must be true and tested**
- [ ] Tests run with a fake client and no network.
- [ ] The API key never appears in logs or thrown error messages (test by forcing an error).
- [ ] A README section shows the three steps a workspace owner takes.

**Out of scope**
- Server endpoints, UI.

**Depends on:** #41

**Branch:** `task/<issue-number>-j71` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

### J72 · connectors: interface + Obsidian (local vault)  #43

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Proves the ingestion pipeline with no auth (Spec 05 §3–§4).

**Read first**
- docs/specs/05-tool-providers.md §3–§4

**Do exactly this**
1. Create `packages/connectors` with the `Connector` interface in `src/types.ts` verbatim.
2. `src/obsidian.ts`: containers = top-level folders; items = `.md` files; `toSession` turns a note into turns — one per top-level heading section, `role:'note'`; frontmatter `openkt-space` overrides the container's space; `content_hash` = sha256 of the body; files with `openkt: false` in frontmatter are skipped.
3. `poll` returns files whose mtime is newer than `since`.

**Files you may touch**
- `packages/connectors/**`

**Acceptance — every line must be true and tested**
- [ ] `toSession` is tested with 6 fixture notes (no headings, nested headings, frontmatter, empty, huge > 200 KB → truncated with a marker turn, skipped).
- [ ] typecheck and tests pass.

**Out of scope**
- Watching the filesystem (the app does that).

**Depends on:** #41

**Branch:** `task/<issue-number>-j72` · **Rules:** `AGENTS.md`

### J73 · connectors: Notion, Google Drive, Linear, Gmail `toSession` + list/backfill/poll  #44

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** One module per product, all behind the provider interface (Spec 05).

**Read first**
- docs/specs/05-tool-providers.md §3–§4
- packages/connectors/src/obsidian.ts as the pattern

**Do exactly this**
1. One file per product. Use only `provider.call(action, params)` — no direct HTTP, no product SDKs.
2. Turn rules from Spec 05 §4: document → a turn per top-level section; email thread → a turn per message; ticket → description + a turn per comment.
3. Flatten rich content to markdown with `turndown` (allowed dependency).
4. Open one pull request per product.

**Files you may touch**
- `packages/connectors/src/<product>.ts`
- `packages/connectors/test/<product>.test.ts`
- fixtures of provider responses

**Acceptance — every line must be true and tested**
- [ ] `toSession` is pure and covered by fixtures for each product.
- [ ] `backfill` pages through a fake provider with 3 pages and returns every item once.
- [ ] Items over 200 KB are truncated with the marker turn.

**Out of scope**
- Slack.
- Attachments.

**Depends on:** #43

**Branch:** `task/<issue-number>-j73` · **Rules:** `AGENTS.md`

### J74 · server + app: connector setup flow and the poll job  #45

`junior` `needs-senior-review` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Spec 05 §4 decisions: explicit containers, one container → one space, 15-minute poll.

**Read first**
- docs/specs/05-tool-providers.md §4
- the container-picker artboard from the canvas issue

**Do exactly this**
1. Server: `provider_configs` (encrypted), `connections`, `connector_containers(container → project_id)` tables; endpoints to set a provider config (workspace owner), begin/finish a connection, list containers, map containers to spaces.
2. Job `connector_poll` per mapped container every 15 minutes: `poll` → `toSession` → `POST /v1/sessions` semantics with `(source, external_id)` de-duplication → close → normal pipeline.
3. App: Settings → Connectors gains Add tool → provider key (owner only) → connect → pick containers → pick a space per container, with the sentence from Spec 05 §4 shown before confirming.

**Files you may touch**
- server connector module
- apps/desktop connectors screens
- `tests`

**Acceptance — every line must be true and tested**
- [ ] Nothing is pulled before at least one container is mapped.
- [ ] An unchanged item polled twice creates one session.
- [ ] A changed item creates a new session whose facts supersede the old ones through the normal dedupe path.
- [ ] Provider keys are never returned by any endpoint.

**Depends on:** #42, #44, #26, #3

**Branch:** `task/<issue-number>-j74` · **Rules:** `AGENTS.md` · a senior engineer reviews this pull request before merge

---

## Version 1.0 Anyone can run it

| Task | Who | Title | Depends on |
|---|---|---|---|
| #46 J80 | junior | Docs site with interactive examples | #15 |
| #47 J81 | junior | Landing page copy for openkt.ai from product.md | — |


### J80 · Docs site with interactive examples  #46

`junior` `blocked`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** Public docs at openkt.ai/docs, generated from this repository.

**Read first**
- `docs/product.md`
- `docs/architecture.md`
- `docs/specs/04-api-contract.md`
- `plugin/README.md`

**Do exactly this**
1. Scaffold `apps/docs` with Astro Starlight (allowed dependency). Pages: What it is · Quick start (hosted / self-run) · Connect your AI tool (one page per client, sourced from `plugin/skills/openkt/references/`) · Concepts · Access and sharing · The desktop app · Self-hosting · Models and providers · API reference (rendered from Spec 04) · MCP tools.
2. Interactive pieces: a `Try recall` playground that calls a configurable server URL with a pasted token (never stored), and a setup-prompt generator that fills the server URL into `plugin/SETUP_PROMPT.md`.
3. Copy follows product.md's words. No invented numbers, customers or quotes.

**Files you may touch**
- `apps/docs/**`

**Acceptance — every line must be true and tested**
- [ ] `npm run build -w apps/docs` succeeds with no broken links (add a link checker).
- [ ] The playground works against a local server and shows a clear message when it cannot connect.

**Out of scope**
- Deploying.

**Depends on:** #15

**Branch:** `task/<issue-number>-j80` · **Rules:** `AGENTS.md`

### J81 · Landing page copy for openkt.ai from product.md  #47

`junior`

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** The current site speaks only to engineers ("skip the 47k-token repo scan"). The product is now for every knowledge worker.

**Read first**
- `docs/product.md`

**Do exactly this**
1. Write `docs/site/landing.md`: hero (≤ 12 words) + one-sentence sub; the three losses (between sessions, tools, people); four before/after cards from product.md personas; how it works in 5 steps; open source and self-run section; the three install levels. Every claim must be traceable to product.md.
2. No benchmarks, no customer logos, no "10x".

**Files you may touch**
- `docs/site/landing.md`

**Acceptance — every line must be true and tested**
- [ ] A reviewer can point each paragraph to a product.md section (add the section name as an HTML comment above each block).

**Out of scope**
- Changing the live site — that is a separate, senior-approved deploy.

**Depends on:** nothing — can start now

**Branch:** `task/<issue-number>-j81` · **Rules:** `AGENTS.md`
