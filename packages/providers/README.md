# @openkt/providers

Tool provider plugins for OpenKT (Spec 05 section 2): the `ToolProvider` interface, the registry, and the `local` filesystem provider.

A **connector** (what to pull and how to turn it into sessions) never knows which provider is underneath; a **provider** (how to authenticate and make the API call) never knows what a session is.

```
npm run typecheck -w @openkt/providers
npm test -w @openkt/providers
```
