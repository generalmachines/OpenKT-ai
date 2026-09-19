# Spec 05 — tool providers and connectors

> Owner: senior. Status: decided. Goal: context that already lives in other products (Gmail, Notion, Linear, Drive, Slack, an Obsidian vault) arrives in OpenKT as sessions. **Where the credentials and API calls come from is a plugin**, so nobody is locked to one vendor. Composio is the first plugin.

## 1. Two layers, kept apart

```
Connector  = what to pull and how to turn it into sessions      (ours, one small module per product)
Provider   = how to authenticate and make the API call          (a plugin: Composio, direct OAuth, local files, …)
```

A connector never knows which provider is underneath. A provider never knows what a session is.

## 2. Provider interface (`packages/providers/src/types.ts`)

```ts
export interface ToolProvider {
  id: string;                                   // 'composio' | 'local' | 'direct-oauth' | …
  configSchema: JSONSchema;                     // what the workspace admin fills in (e.g. { apiKey })
  listApps(): Promise<AppInfo[]>;               // apps this provider can reach: { app: 'notion', name, authKind }
  beginConnect(ctx: { userId: string; app: string; redirectUrl: string }): Promise<{ connectUrl?: string; connectionId: string }>;
  getConnection(connectionId: string): Promise<{ status: 'pending' | 'active' | 'error'; account?: string }>;
  call<T>(connectionId: string, action: string, params: Record<string, unknown>): Promise<T>;   // one API action
  subscribe?(connectionId: string, trigger: string, webhookUrl: string): Promise<{ subscriptionId: string }>;
  disconnect(connectionId: string): Promise<void>;
}
```

- Provider config (the team's Composio API key, for instance) is stored encrypted in `provider_configs(org_id, provider_id, config_enc)`. Users never paste keys into chat.
- `composio` plugin: `beginConnect` returns Composio's hosted connect link (people sign in with their Google or work account there); `call` maps to Composio's execute-action API; `subscribe` maps to Composio triggers. It depends only on Composio's MIT-licensed SDK.
- `local` plugin: no auth; `call('fs.list' | 'fs.read', …)` over a folder the desktop app exposes. Used by the Obsidian connector.
- Anyone can add a provider by implementing the interface and registering it in `packages/providers/src/registry.ts`. No core change.

## 3. Connector interface (`packages/connectors/src/types.ts`)

```ts
export interface Connector {
  app: string;                                   // 'notion' | 'gmail' | 'linear' | 'gdrive' | 'slack' | 'obsidian'
  scopesHint: string[];                          // shown to the user before connecting
  listContainers(p: ProviderHandle): Promise<Container[]>;        // teamspaces / labels / folders / channels / vault folders
  backfill(p: ProviderHandle, container: Container, cursor?: string): Promise<{ items: ExternalItem[]; nextCursor?: string }>;
  poll(p: ProviderHandle, container: Container, since: string): Promise<ExternalItem[]>;
  toSession(item: ExternalItem): SessionDraft;   // pure function — unit-testable without a network
}

type ExternalItem = { externalId: string; url: string; title: string; author?: string; updatedAt: string;
                      body: string | Block[]; participants?: string[] };
type SessionDraft = { source: 'connector'; client: string; external_id: string; external_url: string;
                      title: string; content_hash: string; turns: Turn[] };
```

## 4. Decisions

- **One container maps to one space.** When connecting, the user picks containers (a Notion teamspace, a Gmail label, a Drive folder, a Slack channel, a Linear team) and, for each, the space it feeds. That is the whole permission model in v0.6: whoever can read the space can read what was pulled into it. The connecting user sees this sentence before confirming. Per-item permission mirroring is out of scope.
- **Nothing is pulled without an explicit container choice.** No "sync my whole inbox".
- **Each external item is one session**, `source='connector'`, de-duplicated on `(source, external_id)`; a changed `content_hash` creates a new closed session that supersedes through the normal dedupe path — old facts are superseded, not deleted.
- **Turns:** a document → one turn per top-level section (`role:'note'`); an email thread → one turn per message (`role:'speaker'`, `speaker`= sender name); a ticket → description + one turn per comment; a chat channel → one session per day per channel.
- **Size limits:** items over 200 KB of text are truncated with a marker turn; attachments inside external items are ignored in v0.6.
- **Sync cadence:** `subscribe` when the provider supports triggers, otherwise `poll` every 15 minutes, as `jobs` rows (`kind='connector_poll'`).
- **Order of connectors:** Obsidian (local, no auth — proves the pipeline) → Notion → Google Drive (brings Google Meet transcripts with it) → Linear → Gmail → Slack.
- **Parsing:** HTML and rich blocks are flattened to markdown with `turndown` (MIT) or the product's own block-to-markdown helper. Binary documents are out of scope until a file-parsing provider exists.
