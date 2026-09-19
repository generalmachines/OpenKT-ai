# @openkt/connectors

Connectors for OpenKT (Spec 05 sections 3-4): the `Connector` interface and one small module per product that turns external items into sessions. A connector talks to providers only through the `ProviderHandle` — it never knows which provider is underneath, and a provider never knows what a session is.

One container maps to one space (Spec 05 §4): for Obsidian, the containers are the vault's top-level folders, and notes sitting at the vault root belong to no container, so they never sync.

```
npm run typecheck -w @openkt/connectors
npm test -w @openkt/connectors
```
