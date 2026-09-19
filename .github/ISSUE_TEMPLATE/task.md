---
name: Task
about: Propose one small, fully specified piece of work, in the shape used by docs/tasks/JUNIOR_TASKS.md
title: "[area] short imperative title"
labels: ""
---

<!-- Same shape as every task in docs/tasks/JUNIOR_TASKS.md. A maintainer adds the `junior` label and a milestone once the task is specified well enough for anyone to pick up. Delete a section only if it is truly empty. -->

> Read `AGENTS.md` first. Do exactly what is written here. If something is unclear or looks wrong, comment on the issue — do not improvise.

**Context.** <!-- Two or three sentences: why this exists and where it fits. Name the spec section. -->

**Read first**
- `docs/specs/…`
- `path/to/file.ts`

**Do exactly this**
1.
2.

**Files you may touch**
- `path/to/file.ts`
- `path/to/file.test.ts`

**Acceptance — every line must be true and tested**
- [ ]
- [ ] `npm run typecheck` and `npm test` pass in the package.

**Out of scope**
-

**Depends on:** nothing — can start now <!-- or #issue numbers -->

**Branch:** `task/<issue-number>-<short-slug>` · **Rules:** `AGENTS.md`
