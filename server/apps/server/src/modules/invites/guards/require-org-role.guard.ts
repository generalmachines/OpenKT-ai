import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { and, eq } from "drizzle-orm";

import {
  ForbiddenDomainError,
  NotFoundDomainError,
  UnauthorizedDomainError,
} from "@openkt/core-errors";
import type { OrgRole } from "@openkt/data-repositories";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { orgInvites, orgMembers, orgs } from "../../../db/schema";
import { ORG_ROLE_METADATA_KEY } from "./require-org-role.decorator";

// Returns numeric priority for an org role; higher number = more
// authority. Members < admins < owners.
function rolePriority(role: string): number {
  switch (role) {
    case "owner":
      return 30;
    case "admin":
      return 20;
    case "member":
      return 10;
    default:
      return 0;
  }
}

@Injectable()
export class RequireOrgRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OrgRole | undefined>(
      ORG_ROLE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (!request.actorContext) {
      // SupabaseJwtGuard should already have populated this; if not, fail closed.
      throw new UnauthorizedDomainError("actor context missing");
    }
    const userId = request.actorContext.principal.userId;
    if (!userId) throw new UnauthorizedDomainError("user principal required");

    const orgId = await this.resolveOrgId(request);
    if (!orgId) {
      // Don't leak whether the org / invite exists.
      throw new NotFoundDomainError("org");
    }

    const member = await this.db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)),
    });
    if (!member) throw new NotFoundDomainError("org");

    if (rolePriority(member.role) < rolePriority(required)) {
      throw new ForbiddenDomainError(`${required} role required`);
    }

    // Stash the resolved org id for handlers that want to skip a second lookup.
    (request as RequestWithContext & { resolvedOrgId?: string }).resolvedOrgId = orgId;
    (request as RequestWithContext & { resolvedOrgRole?: string }).resolvedOrgRole = member.role;
    return true;
  }

  // Resolution order: explicit org_slug in body → :orgIdParam in route →
  // derived from :id or :inviteId (invite id) → derived from :token.
  private async resolveOrgId(request: RequestWithContext): Promise<string | null> {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const params = (request.params ?? {}) as Record<string, unknown>;

    const orgSlug = pickString(body.org_slug) ?? pickString(query.org_slug);
    if (orgSlug) {
      const orgRow = await this.db.query.orgs.findFirst({ where: eq(orgs.slug, orgSlug) });
      return orgRow?.id ?? null;
    }

    const orgId = pickString(body.org_id) ?? pickString(query.org_id) ?? pickString(params.orgId);
    if (orgId) return orgId;

    const inviteId = pickString(params.id) ?? pickString(params.inviteId);
    if (inviteId) {
      const row = await this.db.query.orgInvites.findFirst({
        where: eq(orgInvites.id, inviteId),
      });
      return row?.orgId ?? null;
    }

    const token = pickString(params.token) ?? pickString(body.token);
    if (token) {
      const row = await this.db.query.orgInvites.findFirst({
        where: eq(orgInvites.token, token),
      });
      return row?.orgId ?? null;
    }

    return null;
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
