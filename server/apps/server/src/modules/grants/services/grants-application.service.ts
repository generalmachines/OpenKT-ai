import { Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { ForbiddenDomainError, NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import type {
  GrantListItem,
  GrantRecord,
  GrantResourceType,
  GrantRole,
  GrantView,
  PendingGrantView,
} from "../contracts/grant.contract";
import { GrantRepository } from "../repositories/grant.repository";

const GRANT_RANK: Record<GrantRole, number> = { reader: 1, editor: 2, owner: 3 };

// GrantsApplicationService — architecture.md §3: "A grant gives a
// person... a role... on a workspace, a space, or a single session."
// A skill is shared the same way (resource_type = 'skill').
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
  ): Promise<GrantListItem[]> {
    // Owner-only, so the emails below never reach anyone who does not already
    // run this resource's access list.
    await this.requireOwner(context, resourceType, resourceId);
    const [records, pending] = await Promise.all([
      this.grantRepository.list(resourceType, resourceId),
      this.grantRepository.listPending(resourceType, resourceId),
    ]);
    const subjects = await this.grantRepository.findSubjects(records.map((r) => r.subject_id));
    const real = records.map((record) => this.withSubject(record, subjects.get(record.subject_id)));
    return [...real, ...pending];
  }

  // Share by email (or by a user id the caller already holds). A known email
  // becomes a grant right away. An unknown one is remembered and turns into a
  // grant the moment that email signs up — the response says `pending: true`.
  async putByEmailOrSubject(
    context: ActorContext,
    resourceType: GrantResourceType,
    resourceId: string,
    target: { email?: string; subject_id?: string },
    role: GrantRole,
  ): Promise<GrantView | PendingGrantView> {
    const owner = await this.requireOwner(context, resourceType, resourceId);
    const subjectUserId =
      target.subject_id ?? (target.email ? await this.grantRepository.findUserIdByEmail(target.email) : null);

    if (!subjectUserId) {
      if (!target.email) throw new ValidationDomainError("email or subject_id required");
      return this.grantRepository.putPending(resourceType, resourceId, target.email, role, owner.ownerUserId);
    }

    const record = await this.put(context, resourceType, resourceId, subjectUserId, role);
    const subjects = await this.grantRepository.findSubjects([subjectUserId]);
    return this.withSubject(record, subjects.get(subjectUserId));
  }

  private withSubject(record: GrantRecord, subject: GrantView["subject"] | undefined): GrantView {
    return {
      ...record,
      pending: false,
      subject: subject ?? { id: record.subject_id, email: null, display_name: null },
    };
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
    // The id in the path is a user id for a real grant, or the pending share's
    // own id (from the list) for one still waiting on a sign-up.
    const revoked =
      (await this.grantRepository.remove(resourceType, resourceId, subjectUserId)) ||
      (await this.grantRepository.removePending(resourceType, resourceId, subjectUserId));
    return { revoked };
  }

  // Someone opened a join link (modules/teams): they get the link's role on
  // its resource, on behalf of whoever made the link — the same `grants` row
  // an owner's share creates, so there is no second way in. Never lowers a
  // role the person already holds, and the owner stays the owner. Returns the
  // role they end up with. `claim` runs only when a grant is actually needed
  // (it uses up one of the link's uses); when it returns false the link ran
  // out in the meantime and nothing is granted (null).
  async grantByJoinLink(
    resourceType: GrantResourceType,
    resourceId: string,
    subjectUserId: string,
    role: GrantRole,
    invitedBy: string,
    claim: () => Promise<boolean> = async () => true,
  ): Promise<{ role: GrantRole; granted: boolean } | null> {
    const owner = await this.grantRepository.findResourceOwner(resourceType, resourceId);
    if (!owner) throw new NotFoundDomainError(resourceType);
    if (owner.ownerUserId === subjectUserId) return { role: "owner", granted: false };
    const current = await this.grantRepository.findUserRole(resourceType, resourceId, subjectUserId);
    if (current && GRANT_RANK[current] >= GRANT_RANK[role]) return { role: current, granted: false };
    if (!(await claim())) return null;
    await this.grantRepository.put(resourceType, resourceId, owner.orgId, subjectUserId, role, invitedBy);
    return { role, granted: true };
  }

  private async requireOwner(
    context: ActorContext,
    resourceType: GrantResourceType,
    resourceId: string,
  ): Promise<{ ownerUserId: string; orgId: string | null }> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    const owner = await this.grantRepository.findResourceOwner(resourceType, resourceId);

    if (!owner) throw new NotFoundDomainError(resourceType);
    if (owner.ownerUserId !== userId) {
      throw new ForbiddenDomainError(`only the ${resourceType} owner can manage grants`);
    }
    return owner;
  }
}
