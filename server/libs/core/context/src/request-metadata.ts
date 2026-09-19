import type { ExecutionSurface } from "./execution-surface";

export interface RequestMetadata {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  origin: string | null;
  sessionId: string | null;
  surface: ExecutionSurface;
  actorKind: "human" | "cli" | "mcp" | "agent" | "system";
}
