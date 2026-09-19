import type { ActorContext } from "@openkt/core-context";

export interface AuditActorSnapshot {
  actorType: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
  authSource: string;
  serviceName: string | null;
  tokenId: string | null;
  requestId: string | null;
  sessionId: string | null;
  ip: string | null;
  origin: string | null;
  userAgent: string | null;
  surface: string;
}

export function mapAuditActorSnapshot(context: ActorContext): AuditActorSnapshot {
  return {
    actorType: context.principal.type,
    actorUserId: context.principal.userId,
    actorEmail: context.principal.email,
    actorDisplayName: context.principal.displayName,
    authSource: context.principal.authSource,
    serviceName: context.principal.serviceName ?? null,
    tokenId: context.principal.tokenId ?? null,
    requestId: context.request.requestId,
    sessionId: context.request.sessionId,
    ip: context.request.ip,
    origin: context.request.origin,
    userAgent: context.request.userAgent,
    surface: context.request.surface,
  };
}
