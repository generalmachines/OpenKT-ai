# @openkt/pipeline

Pure decision functions for the OpenKT write path (Spec 02): chunking, duplicate rules, tag normalising, routing guards, section validation, confidence. No database, no network, no clock.

Rules for this package: every export is a **pure function** — same input, same output; no database, network, filesystem, `Date.now()` or `Math.random()` (time is always a parameter). One file per function under `src/`, one test file per function under `test/`, one export line in `src/index.ts`.

```
npm run typecheck -w @openkt/pipeline
npm test -w @openkt/pipeline
```
