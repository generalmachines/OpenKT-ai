# @openkt/connectors

Connectors for OpenKT (Spec 05 sections 3-4): the `Connector` interface and one small module per product that turns external items into sessions. A connector talks to providers only through the `ProviderHandle` — it never knows which provider is underneath, and a provider never knows what a session is.

```
npm run typecheck -w @openkt/connectors
npm test -w @openkt/connectors
```
