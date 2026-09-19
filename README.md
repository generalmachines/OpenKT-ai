# OpenKT

An open-source shared context engine for teams. Sessions from any AI tool, meeting or voice note are distilled into a team knowledge base that maintains itself, and handed back to any teammate's tool over MCP — within the access its owner allowed.

Start with the docs:

- [`docs/product.md`](docs/product.md) — what it is, who it is for, the vocabulary
- [`docs/architecture.md`](docs/architecture.md) — the four memory tiers, the agent pipeline, access, MCP
- [`docs/research/`](docs/research/) — the research behind the choices

## Layout

| Path | What |
|---|---|
| `packages/agents` | The single-purpose LLM agents of the write path: prompts, JSON Schemas, fixtures, evaluation |
| `apps/desktop` | The desktop app |
| `plugin` | The Claude plugin |
| `design` | The design canvas |

npm workspaces, Node 22.

```
npm install
npm test --workspaces --if-present
```

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).
