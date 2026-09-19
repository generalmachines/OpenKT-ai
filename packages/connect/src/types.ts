/** What an integration can do once it is connected. Rendered as the capability chips in the app. */
export interface Capabilities {
  /** The OpenKT MCP tools (kt_recall, kt_save_memory, …) are available inside the tool. */
  mcp: boolean;
  /** Conversations are saved as OpenKT sessions without the model having to call anything. */
  autoCapture: boolean;
  /** Relevant context is added to prompts automatically: 'prompt' on every prompt, 'session-start' once per session. */
  autoRecall: false | 'prompt' | 'session-start';
  /** The tool's own memory (Claude Code memory files, Gemini CLI save_memory) is mirrored into OpenKT. */
  nativeMemorySync: boolean;
}

export type IntegrationKind = 'coding-agent' | 'desktop-app' | 'browser' | 'agent';

export type ConnectionStatus = 'connected' | 'partial' | 'not-connected' | 'needs-attention';

export interface Detection {
  installed: boolean;
  version?: string;
  /** The config directory, binary or app bundle that proved it is installed. */
  path?: string;
}

/** One file an apply would touch. `diff` is a short human summary, never file contents with secrets. */
export interface Change {
  file: string;
  action: 'create' | 'modify' | 'delete';
  summary: string;
}

export interface StatusReport {
  status: ConnectionStatus;
  /** Why the status is not `connected` (or what the person still has to do, e.g. approve hooks in Codex). */
  reasons: string[];
  /** Per part: 'mcp', 'hooks', 'skill', 'native-memory', … → present or not. */
  parts: Record<string, boolean>;
}

export interface IntegrationOptions {
  /** Mirror the tool's own memory into OpenKT (only where `capabilities.nativeMemorySync`). Default true. */
  nativeMemory?: boolean;
}

/** For tools that cannot be configured from disk (claude.ai, ChatGPT, any HTTP agent): what the person does instead. */
export interface GuidedSetup {
  /** The page to open, when there is one. */
  openUrl?: string;
  /** The value to copy (the MCP URL). Never a token. */
  copy?: string;
  steps: string[];
  /** Why this cannot be completed right now, when the server is not ready for it. */
  blocked?: string;
}

export interface Integration {
  id: string;
  name: string;
  kind: IntegrationKind;
  capabilities: Capabilities;
  /** One sentence on the "sync its own memory" option, when the tool has one. */
  nativeMemoryNote?: string;
  /** Docs the installer was written against. */
  docs: string[];
  detect(env: ConnectEnv): Promise<Detection>;
  status(env: ConnectEnv): Promise<StatusReport>;
  plan(env: ConnectEnv, options?: IntegrationOptions): Promise<Change[]>;
  apply(env: ConnectEnv, options?: IntegrationOptions): Promise<Change[]>;
  undo(env: ConnectEnv): Promise<Change[]>;
  /** Present for tools set up by hand in their own UI. */
  guide?(env: ConnectEnv): Promise<GuidedSetup>;
}

/** Everything that differs between a real machine and a test: no global state is read anywhere else. */
export interface ConnectEnv {
  home: string;
  /** ~/.openkt unless OPENKT_HOME says otherwise. */
  openktHome: string;
  platform: NodeJS.Platform;
  /** Directories searched for tool binaries. */
  path: string[];
  /** Used for backup file names; injectable so tests are deterministic. */
  now: () => Date;
  /** Environment variables relevant to connect (XDG_CONFIG_HOME, OPENKT_SERVER, …). */
  vars: Record<string, string | undefined>;
}
