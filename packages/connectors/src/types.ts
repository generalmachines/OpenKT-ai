// Connector interface, verbatim from docs/specs/05-tool-providers.md section 3.
// A connector knows what to pull and how to turn it into sessions; it never
// knows which provider is underneath (ProviderHandle abstracts that).

// The spec leaves four types open; defined here per the J72 clarification:
export type ProviderHandle = { call<T>(action: string, params: Record<string, unknown>): Promise<T> }; // a provider bound to one connection — the app wraps ToolProvider.call(connectionId, …)
export type Container = { id: string; name: string };
export type Block = Record<string, unknown>; // J73 narrows this
export type Turn = { seq: number; role: 'user' | 'assistant' | 'speaker' | 'system' | 'note'; speaker?: string; content: string }; // Spec 01 `session_turns`

export type ExternalItem = { externalId: string; url: string; title: string; author?: string; updatedAt: string;
                      body: string | Block[]; participants?: string[] };
export type SessionDraft = { source: 'connector'; client: string; external_id: string; external_url: string;
                      title: string; content_hash: string; turns: Turn[] };

export interface Connector {
  app: string;                                   // 'notion' | 'gmail' | 'linear' | 'gdrive' | 'slack' | 'obsidian'
  scopesHint: string[];                          // shown to the user before connecting
  listContainers(p: ProviderHandle): Promise<Container[]>;        // teamspaces / labels / folders / channels / vault folders
  backfill(p: ProviderHandle, container: Container, cursor?: string): Promise<{ items: ExternalItem[]; nextCursor?: string }>;
  poll(p: ProviderHandle, container: Container, since: string): Promise<ExternalItem[]>;
  toSession(item: ExternalItem): SessionDraft;   // pure function — unit-testable without a network
}
