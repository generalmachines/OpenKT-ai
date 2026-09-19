# Working in this repository — read this first

These are the task rules for everyone who picks up an issue here, human or AI agent. You are picking up one issue. A maintainer has already made the design decisions. Your job is to implement exactly what the issue says, prove it with tests, and open a pull request. **Do not redesign. Do not widen the task.**

New to the project? [`README.md`](README.md) says what OpenKT is and what runs today; [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, checks and the pull request flow.

## The rules

1. **One issue, one branch, one pull request.** Branch name: `task/<issue-number>-<short-slug>`. Never commit to `main`.
2. **Read before writing:** the issue, then every file it lists under "Read first". The specs in `docs/specs/` are law. If the issue and a spec disagree, the spec wins — say so in the pull request.
3. **Touch only the files the issue lists** under "Files". Need another file? Stop and comment on the issue.
4. **No new dependencies** unless the issue names them. No new services, no new frameworks.
5. **Do not edit** `docs/specs/**`, `docs/product.md`, `docs/architecture.md`, `design/**`, `packages/agents/prompts/**` or `packages/agents/schemas/**`. Those belong to the maintainers. Think one is wrong? Open an issue labelled `question`.
6. **Tests are the deliverable.** Every issue has an "Acceptance" list. Each line must be true, and each must be covered by a test you wrote or a command whose output you paste into the pull request.
7. **Run before you push:** `npm run typecheck && npm test` in the package you changed. Paste the last lines of output into the pull request. A red test means you are not done.
8. **Stuck for more than three attempts on the same error?** Stop. Comment on the issue: what you tried, the exact error, the file and line. Do not work around it by deleting tests, loosening types (`any`, `@ts-ignore`), or catching and ignoring errors.
9. **Never** commit secrets, `.env` files, `node_modules`, build output, or model weights. Never run `git add -A`; stage files by path.
10. **Do not invent facts in code comments or docs** — no made-up benchmarks, versions or URLs.

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
Commands run      (paste the tail of typecheck + test output)
Anything unsure   (or "nothing")
```

## Labels

`senior` a maintainer task: decided and built by a maintainer · `junior` a contributor task: fully specified and ready to pick up · `blocked` has an open dependency (listed in the issue) · `needs-mac` must be built and tested on Apple Silicon · `needs-senior-review` a maintainer reads the pull request before merge · `question` you need a decision.

The label names `senior` and `junior` describe the task, not the person: a `junior` task is small and fully specified so that anyone can complete it without knowing the rest of the system. The names are kept because the task tooling (`docs/tasks/`) depends on them.

Pick an issue that is `junior`, not `blocked`, and unassigned. Assign yourself if you can, or comment that you are taking it, then start.
