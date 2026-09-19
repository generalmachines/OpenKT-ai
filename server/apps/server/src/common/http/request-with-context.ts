import type { Request } from "express";

import type { ActorContext, RequestMetadata } from "@openkt/core-context";
import type { AuditActorSnapshot } from "@openkt/platform-audit";

export interface RequestWithContext extends Request {
  requestMetadata?: RequestMetadata;
  actorContext?: ActorContext;
  auditSnapshot?: AuditActorSnapshot;
}
