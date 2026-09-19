import type {
  ActorOAuthIdentity,
  ActorPrincipal,
  ExecutionSurface,
  RequestMetadata,
} from "@openkt/core-context";

export interface ResolvedUserIdentity {
  userId: string;
  email: string | null;
  displayName: string | null;
  // Optional — populated when the upstream session is OAuth-backed (e.g.
  // Supabase reports `app_metadata.provider = 'github'`). The repository
  // layer reads this on the lazy-create path so the first /v1/profile/me
  // request after a GitHub login lands a fully-populated profile row.
  oauthIdentity?: ActorOAuthIdentity | null;
}

const EXECUTION_SURFACES: ReadonlySet<ExecutionSurface> = new Set([
  "web",
  "cli",
  "mcp",
  "plugin",
  "worker",
  "system",
]);

export const REQUEST_METADATA_HEADERS = {
  sessionId: "x-openkt-session-id",
  actorKind: "x-openkt-actor-kind",
  surface: "x-openkt-surface",
} as const;

export function parseExecutionSurface(value: string | null | undefined): ExecutionSurface {
  if (!value) return "web";
  const normalized = value.trim().toLowerCase();
  if (EXECUTION_SURFACES.has(normalized as ExecutionSurface)) {
    return normalized as ExecutionSurface;
  }
  return "web";
}

export function actorKindFromSurface(
  surface: ExecutionSurface,
): RequestMetadata["actorKind"] {
  switch (surface) {
    case "cli":
      return "cli";
    case "mcp":
      return "mcp";
    case "plugin":
    case "worker":
      return "agent";
    case "system":
      return "system";
    case "web":
    default:
      return "human";
  }
}

export function actorKindForPrincipal(
  surface: ExecutionSurface,
  principal: Pick<ActorPrincipal, "type" | "authSource">,
): RequestMetadata["actorKind"] {
  if (principal.type === "system" || principal.authSource === "system") {
    return "system";
  }
  if (principal.authSource === "mcp-token" || surface === "mcp") {
    return "mcp";
  }
  if (surface === "cli") {
    return "cli";
  }
  if (principal.type === "service" || surface === "plugin" || surface === "worker") {
    return "agent";
  }
  return "human";
}

export function buildUserPrincipal(
  identity: ResolvedUserIdentity,
  authSource: Extract<ActorPrincipal["authSource"], "supabase-jwt" | "mcp-token">,
  tokenId?: string | null,
  scopes?: string[] | null,
): ActorPrincipal {
  return {
    type: "user",
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    authSource,
    tokenId: tokenId ?? null,
    oauthIdentity: identity.oauthIdentity ?? null,
    scopes: scopes ?? null,
  };
}

export function buildServicePrincipal(serviceName: string): ActorPrincipal {
  return {
    type: "service",
    userId: null,
    email: null,
    displayName: serviceName,
    authSource: "service-token",
    serviceName,
    tokenId: null,
  };
}

export function extractBearerToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token ? token : null;
}
