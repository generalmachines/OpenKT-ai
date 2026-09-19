/**
 * The shapes packages/connect returns (ToolInfo, Change, GuidedSetup, SelfTestResult, FolderMapping), declared here so
 * the renderer and main typecheck without building packages/connect first. Keep in step with packages/connect/src.
 */
export type ConnectStatusDto = 'connected' | 'partial' | 'not-connected' | 'needs-attention';

export interface ConnectCapabilitiesDto {
  mcp: boolean;
  autoCapture: boolean;
  autoRecall: false | 'prompt' | 'session-start';
  nativeMemorySync: boolean;
}

export interface ConnectToolDto {
  id: string;
  name: string;
  kind: 'coding-agent' | 'desktop-app' | 'browser' | 'agent';
  capabilities: ConnectCapabilitiesDto;
  nativeMemoryNote?: string;
  detected: { installed: boolean; version?: string; path?: string };
  status: ConnectStatusDto;
  reasons: string[];
  parts: Record<string, boolean>;
  guided: boolean;
  docs: string[];
}

export interface ConnectChangeDto {
  file: string;
  action: 'create' | 'modify' | 'delete';
  summary: string;
}

export interface ConnectGuideDto {
  openUrl?: string;
  copy?: string;
  steps: string[];
  blocked?: string;
}

export interface ConnectTestDto {
  ok: boolean;
  session_id: string | null;
  context_md: string;
  steps: { event: string; ms: number; output: string }[];
  problem?: string;
}

export interface ConnectFolderDto {
  path: string;
  space_id: string | null;
  space_name?: string;
  state: 'mapped' | 'personal' | 'pending';
  first_seen?: string;
}

/** Errors cross IPC as a value, never a throw: `code` follows packages/connect (config_unreadable, not_installed, …). */
export interface ConnectErrorDto {
  error: { code: string; message: string; hint?: string; file?: string };
}

/** What the app knows about the sign-in, so the hooks can use it too (the shared credentials store, Spec 06 §2). */
export interface ConnectSignInDto {
  server: string;
  token: string;
}

export interface ConnectBridge {
  /** Every tool: detected on this Mac, status, capabilities. */
  list(): Promise<ConnectToolDto[] | ConnectErrorDto>;
  /** The exact files a connect would touch. */
  plan(id: string, options?: { nativeMemory?: boolean }): Promise<ConnectChangeDto[] | ConnectErrorDto>;
  /** Tick. `signIn` is stored for the hooks when the shared store has no token for that server yet. */
  apply(id: string, options?: { nativeMemory?: boolean }, signIn?: ConnectSignInDto): Promise<{ changes: ConnectChangeDto[]; tool: ConnectToolDto } | ConnectErrorDto>;
  /** Untick: puts every file back. */
  undo(id: string): Promise<{ changes: ConnectChangeDto[]; tool: ConnectToolDto } | ConnectErrorDto>;
  /** Steps for tools set up in their own UI (claude.ai, ChatGPT, any agent). */
  guide(id: string): Promise<ConnectGuideDto | null | ConnectErrorDto>;
  /** claude.ai / ChatGPT: true once a new OAuth sign-in for this person appears after `sinceIso`. */
  detectWeb(id: string, sinceIso: string): Promise<boolean | ConnectErrorDto>;
  /** A real session-start → prompt → session-end through the installed hook script. */
  test(id: string): Promise<ConnectTestDto | ConnectErrorDto>;
  folders(): Promise<ConnectFolderDto[] | ConnectErrorDto>;
  mapFolder(path: string, spaceId: string | null, spaceName?: string): Promise<ConnectFolderDto[] | ConnectErrorDto>;
  /** Stores the app's sign-in in the shared store now (also done by apply). */
  shareSignIn(signIn: ConnectSignInDto): Promise<{ stored: 'keychain' | 'file' | 'unchanged' } | ConnectErrorDto>;
}

export function isConnectError(v: unknown): v is ConnectErrorDto {
  return !!v && typeof v === 'object' && 'error' in v && !!(v as ConnectErrorDto).error && typeof (v as ConnectErrorDto).error.code === 'string';
}
