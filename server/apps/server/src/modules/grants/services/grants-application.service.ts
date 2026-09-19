import { Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError, NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import type { GrantRecord, GrantResourceType, GrantRole } from "../contracts/grant.contract";
import { GrantRepository } from "../repositories/grant.repository";

// GrantsApplicationService — architecture.md §3: "A grant gives a
// person... a role... on a workspace, a space, or a single session."
// Management is owner-only (product.md "Grant and role" — "access
// works like a code host"): only the resource's literal owner can
// list/add/revoke grants on it. This is deliberately stricter than
// ProjectScopeService.requireProjectAccess("admin") (which also
// allows org admins) — sharing decisions on someone's project stay
// with that project's owner.
@Injectable()
export class GrantsApplicationService {
  constructor(private readonly grantRepository: GrantRepository) {}

  async list(
    context: ActorContext,
    resourceType: GrantResourceType,
    resourceId: string,
  ): Promise<GrantRecord[]> {
    await this.requireOwner(context, resourceType, resourceId);
    return this.grantRepository.list(resourceType, resourceId);
  }

  async put(
    context: ActorContext,
    resourceType: GrantResourceType,
    resourceId: string,
    subjectUserId: string,
    role: GrantRole,
  ): Promise<GrantRecord> {
    const owner = await this.requireOwner(context, resourceType, resourceId);
    if (subjectUserId === owner.ownerUserId) {
      throw new ValidationDomainError("the owner already has full access; grants are for others");
    }
    const actorUserId = context.principal.userId;
    if (!actorUserId) throw new ValidationDomainError("user principal required");
    return this.grantRepository.put(
      resourceType,
      resourceId,
      owner.orgId,
      subjectUserId,
      role,
      actorUserId,
    );
  }

  async remove(
    context: ActorContext,
    resourceType: GrantResourceType,
    resourceId: string,
    subjectUserId: string,
  ): Promise<{ revoked: boolean }> {
    await this.requireOwner(context, resourceType, resourceId);
    const revoked = await this.grantRepository.remove(resourceType, resourceId, subjectUserId);
    return { revoked };
  }

  private async requireOwner(
    context: ActorContext,
    resourceType: GrantResourceType,
    resourceId: string,
  ): Promise<{ ownerUserId: string; orgId: string | null }> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    const owner =
      resourceType === "project"
        ? await this.grantRepository.findProjectOwner(resourceId)
        : resourceType === "session"
          ? await this.grantRepository.findSessionOwner(resourceId)
          : null;

    if (!owner) throw new NotFoundDomainError(resourceType);
    if (owner.ownerUserId !== userId) {
      throw new ForbiddenDomainError(`only the ${resourceType} owner can manage grants`);
    }
    return owner;
  }
}
