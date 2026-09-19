// Provider interface, verbatim from docs/specs/05-tool-providers.md section 2.
// A provider knows how to authenticate and make API calls; it never knows
// what a session is (the connector layer owns that).

/** Minimal JSON-Schema shape for provider config (what the workspace admin fills in). */
export type JSONSchema = Record<string, unknown>;

export interface AppInfo {
  app: string; // 'notion' | 'gmail' | 'obsidian' | …
  name: string;
  authKind: string; // 'none' | 'oauth' | 'api-key' | …
}

export interface ToolProvider {
  id: string; // 'composio' | 'local' | 'direct-oauth' | …
  configSchema: JSONSchema; // what the workspace admin fills in (e.g. { apiKey })
  listApps(): Promise<AppInfo[]>; // apps this provider can reach: { app: 'notion', name, authKind }
  beginConnect(ctx: { userId: string; app: string; redirectUrl: string }): Promise<{ connectUrl?: string; connectionId: string }>;
  getConnection(connectionId: string): Promise<{ status: 'pending' | 'active' | 'error'; account?: string }>;
  call<T>(connectionId: string, action: string, params: Record<string, unknown>): Promise<T>; // one API action
  subscribe?(connectionId: string, trigger: string, webhookUrl: string): Promise<{ subscriptionId: string }>;
  disconnect(connectionId: string): Promise<void>;
}
