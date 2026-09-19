# @openkt/recall

Pure ranking functions for OpenKT recall (Spec 01 section 4): weights, fusion, abstain, diversity, budget, plus the rerank HTTP client.

Rules for this package: every export is a **pure function** — same input, same output; no database, network, filesystem, `Date.now()` or `Math.random()` (time is always a parameter). One file per function under `src/`, one test file per function under `test/`, one export line in `src/index.ts`.

```
npm run typecheck -w @openkt/recall
npm test -w @openkt/recall
```
