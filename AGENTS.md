# Working in this repository — read this first

These are the task rules for everyone who picks up an issue here, human or AI agent. You are picking up one issue. A maintainer has already made the design decisions. Your job is to implement exactly what the issue says, prove it with tests, and open a pull request. **Do not redesign. Do not widen the task.**

New to the project? [`README.md`](README.md) says what OpenKT is and what runs today; [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, checks and the pull request flow.

## The rules

1. **One issue, one branch, one pull request.** Branch name: `task/<issue-number>-<short-slug>`. Never commit to `main`. Start every branch from a fresh `main`: `git fetch origin && git switch -c task/<n>-<slug> origin/main`. If a file the issue mentions is missing, your clone is behind — fetch before you ask.
2. **Read before writing:** the issue, **every comment on it**, then every file it lists under "Read first" — on current `main`, because specs get clarified. The specs in `docs/specs/` are law. If the issue and a spec disagree, the spec wins — say so in the pull request.
3. **Touch only the files the issue lists** under "Files". Need another file? Stop and comment on the issue.
4. **No new dependencies** unless the issue names them. No new services, no new frameworks.
5. **Do not edit** `docs/specs/**`, `docs/product.md`, `docs/architecture.md`, `design/**`, `packages/agents/prompts/**` or `packages/agents/schemas/**`. Those belong to the maintainers. Think one is wrong? Open an issue labelled `question`.
6. **Tests are the deliverable.** Every issue has an "Acceptance" list. Each line must be true, and each must be covered by a test you wrote or a command whose output you paste into the pull request. A test must fail when the behaviour it names is removed: assert exact values (`toEqual`, `toBe`), and for every limit or threshold put one case exactly on the edge and one just past it (a cut at 32 characters needs an input whose character 32 is the one being trimmed).
7. **Run before you push**, from the repository root, on your branch after `git fetch origin && git merge origin/main`: `npm ci` (once), then `npm run typecheck -w <package>` and `npm test -w <package>` (for example `-w @openkt/pipeline`; the server has its own commands in `server/WHERE_THINGS_LIVE.md`). Paste the last lines of that output, unedited. The file and test counts must be the ones your branch produces — never output from another checkout or from a folder holding other tasks' files. A red test, or a pull request GitHub marks as conflicting, means you are not done.
8. **Stuck for more than three attempts on the same error?** Stop. Comment on the issue: what you tried, the exact error, the file and line. Do not work around it by deleting tests, loosening types (`any`, `@ts-ignore`), or catching and ignoring errors.
9. **Never** commit secrets, `.env` files, `node_modules`, build output, or model weights. Never run `git add -A`; stage files by path.
10. **Do not invent facts in code comments or docs** — no made-up benchmarks, versions or URLs.
11. **Shared export lists** (`src/index.ts` in a package): add your one line in alphabetical order. When merging `main` conflicts there, keep every line from both sides — never drop another task's export.
12. **Review before new work.** Keep at most two pull requests open. Before you pick up another issue, answer every review on your open pull requests: push the fixes, then comment on the pull request with one line per numbered point and the commit that fixes it. A review that starts with "Changes requested" is a change request even when GitHub shows it as a comment, and an addendum on the pull request or a spec clarification posted on the issue is part of that review.

## Code style

- TypeScript strict. Small files. Pure functions where the issue asks for a pure function: no database, no network, no clock (`now` is a parameter), no randomness.
- Name things with the product's words: session, fact, page, section, brief, space, grant. The database still says `projects` and `memories`; keep those names in SQL and map at the edge.
- Errors: throw typed errors from `errors.ts` of the package; never return `null` to mean failure.
- User-facing text: short, plain, sentence case, no exclamation marks, no emoji.
- Desktop UI must match `design/canvas/*.dc.html`. If a screen is not on the canvas, it is not ready to build — comment on the issue.

## Pull request template

```
Closes #<n>

What I did        (3 lines max)
Acceptance        (copy the list from the issue, tick each, link the test)
Commands run      (paste the tail of `npm run typecheck -w <pkg>` + `npm test -w <pkg>`, run on this branch merged with main)
Anything unsure   (or "nothing")
```

## Labels

`senior` a maintainer task: decided and built by a maintainer · `junior` a contributor task: fully specified and ready to pick up · `blocked` has an open dependency (listed in the issue) · `needs-mac` must be built and tested on Apple Silicon · `needs-senior-review` a maintainer reads the pull request before merge · `question` you need a decision.

The label names `senior` and `junior` describe the task, not the person: a `junior` task is small and fully specified so that anyone can complete it without knowing the rest of the system. The names are kept because the task tooling (`docs/tasks/`) depends on them.

Pick an issue that is `junior`, not `blocked`, and unassigned. Assign yourself if you can, or comment that you are taking it, then start.
