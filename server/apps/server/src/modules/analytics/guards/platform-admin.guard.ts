import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";

import { ForbiddenDomainError } from "@openkt/core-errors";

import type { RequestWithContext } from "../../../common/http/request-with-context";

// PlatformAdminGuard — gates /v1/internal/analytics/admin behind a
// hardcoded allowlist of user UUIDs supplied via env var
// OPENKT_PLATFORM_ADMIN_USER_IDS (comma-separated). A `platform_admins`
// table can replace this later; until then this matches the pattern
// the spec asked for explicitly.
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const userId = request.actorContext?.principal.userId;
    if (!userId) throw new ForbiddenDomainError("user principal required");
    const allowlist = parseAllowlist(process.env.OPENKT_PLATFORM_ADMIN_USER_IDS);
    if (!allowlist.has(userId)) {
      throw new ForbiddenDomainError("platform admin required");
    }
    return true;
  }
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}
