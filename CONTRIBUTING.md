# Contributing to OpenKT

Contributions are welcome from people and from AI agents working on a person's behalf. The same rules apply to both, and the project is organised so that either can do useful work without knowing the whole system.

Read these first:

- [`README.md`](README.md) — what OpenKT is and what runs today.
- [`AGENTS.md`](AGENTS.md) — the task rules. Short, and binding for every pull request.
- [`PLAN.md`](PLAN.md) — the versions, and who builds what.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## How the work is organised

Maintainers make the design decisions and write them down: the product in [`docs/product.md`](docs/product.md), the system in [`docs/architecture.md`](docs/architecture.md), and the binding details in [`docs/specs/`](docs/specs/). Everything else is cut into small, fully specified tasks. Each task says what to read, exactly what to do, which files it may touch, and how it is accepted. The full list is in [`docs/tasks/JUNIOR_TASKS.md`](docs/tasks/JUNIOR_TASKS.md), mirrored as GitHub issues.

### Labels

| Label | Meaning |
|---|---|
| `junior` | A contributor task: fully specified and open to anyone. Start here. |
| `senior` | A maintainer task: a design decision or a risky part of the core. |
| `blocked` | Depends on an open issue, listed under "Depends on". |
| `needs-senior-review` | A maintainer reads the pull request before it merges. |
| `needs-mac` | Must be built and tested on Apple Silicon. |
| `question` | A decision is needed from a maintainer. |
| `bug` | Something does not behave as documented. |

The names `senior` and `junior` describe the task, not the person doing it. They are kept because the task tooling in `docs/tasks/` depends on them.

### Milestones

One milestone per version in `PLAN.md`, from `0.1 Team retrieval over MCP` to `1.0 Anyone can run it`. Each version is a working product on its own. Prefer tasks in the earliest open milestone.

## Picking up a task

1. Choose an issue labelled `junior` that is not `blocked` and has no assignee. Comment that you are taking it; a maintainer will assign you.
2. Read the issue, then every file it lists under "Read first". If the issue and a spec disagree, the spec wins — say so in the pull request.
3. Create a branch from `main` named `task/<issue-number>-<short-slug>`. Forks are fine.
4. Do exactly what the issue says, in the files it lists. If you need another file or a new dependency, stop and comment on the issue.
5. Run the checks below, then open a pull request against `main`. The pull request template asks for the acceptance list and the tail of the command output.
6. A maintainer reviews. Expect questions where the change goes beyond the issue.

Found a bug, or want something that has no issue? Open one first, using the bug or task template. Unsure about a decision? Use the question template. Small fixes to documentation can go straight to a pull request.

Design changes — the specs, `docs/product.md`, `docs/architecture.md`, `design/`, and the agent prompts and schemas in `packages/agents` — start as a `question` issue, not as a pull request.

## Set up and run the checks

You need Node 22 and npm. Python 3 is needed only for the task and design generators.

```
npm ci
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm run build --workspaces --if-present
```

For one package, add `-w`: `npm test -w @openkt/recall`. The server is not part of the root workspaces; it has its own lockfile and instructions in [`server/WHERE_THINGS_LIVE.md`](server/WHERE_THINGS_LIVE.md):

```
cd server
npm ci
npm run typecheck
npm run test:unit
```

To see your changes:

```
npm run dev -w @openkt/desktop         # the app's UI in a browser with sample data, http://localhost:5173
npm run start -w @openkt/desktop       # build and open the Electron app
npm run preview -w @openkt/mcp-cards   # the MCP cards in a fake host, http://127.0.0.1:4180/preview.html
```

To run the server locally you need Postgres 16 with pgvector; [`server/README.md`](server/README.md) has the steps.

Continuous integration runs the same commands on every pull request. A red check means the pull request is not done. Do not make a check pass by deleting tests, loosening types or ignoring errors.

Two files are generated; edit the source, not the output:

- `docs/tasks/JUNIOR_TASKS.md` comes from `docs/tasks/issues.py`. Render it with `python3 docs/tasks/build.py`. The `--github` flag creates and edits issues, so only maintainers run it.
- `design/canvas/*.dc.html` comes from `python3 design/gen.py`.

## Working with an AI agent

Point the agent at `AGENTS.md` and one issue. The issue format is written to be followed literally. You are responsible for what you submit: read the diff, run the checks yourself, and say in the pull request which parts an agent wrote if that helps the reviewer.

## Commits and pull requests

- One issue, one branch, one pull request. Keep unrelated changes out.
- Stage files by path. Never commit secrets, `.env` files, `node_modules`, build output or model weights.
- Write commit messages that say what changed and why, in plain sentences.
- Do not invent facts in code comments or documentation: no made-up benchmarks, versions or links.

## Licence of contributions

OpenKT is licensed under [Apache-2.0](LICENSE). By submitting a contribution you agree that it is licensed under the same terms, as section 5 of the licence describes. There is no contributor licence agreement and no sign-off requirement. Only submit work you have the right to contribute, and keep third-party code out unless its licence is compatible and it is listed in [`NOTICE`](NOTICE).

## Security

Do not report vulnerabilities in public issues. See [`SECURITY.md`](SECURITY.md).
