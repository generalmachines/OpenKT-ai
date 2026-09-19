import { randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import {
  ForbiddenDomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";
import {
  INVITE_REPOSITORY,
  ORG_REPOSITORY,
  type CreateOrgInviteInput,
  type InviteMode,
  type InviteRepository,
  type OrgInvitePreview,
  type OrgRepository,
  type OrgRole,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { orgInvites, orgMembers } from "../../../db/schema";
import { AuditService } from "../../audit/services/audit.service";

// `inv_` prefix is human-friendly + a useful magic string for log
// scanners; 24 random bytes => 32 base64url chars after the prefix.
const TOKEN_PREFIX = "inv_";

export interface CreateInviteInput {
  orgSlug: string;
  email: string | null;
  role: OrgRole;
  maxUses: number | null;
  expiresInDays: number;
  isOpen: boolean;
}

export interface CreatedInvite {
  inviteId: string;
  inviteUrl: string;
  token: string;
  mode: InviteMode;
  expiresAt: string;
  role: OrgRole;
  maxUses: number | null;
}

export interface ListedInvite {
  id: string;
  email: string | null;
  role: OrgRole;
  mode: InviteMode;
  expiresAt: string;
  maxUses: number | null;
  usedCount: number;
  createdAt: string;
  inviteUrl: string;
}

export interface AcceptOutcome {
  orgId: string;
  orgSlug: string;
  role: OrgRole;
}

@Injectable()
export class InvitesApplicationService {
  constructor(
    @Inject(INVITE_REPOSITORY) private readonly inviteRepository: InviteRepository,
    @Inject(ORG_REPOSITORY) private readonly orgRepository: OrgRepository,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    context: ActorContext,
    input: CreateInviteInput,
    callerOrgRole: string | null = null,
  ): Promise<CreatedInvite> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    const orgId = await this.orgRepository.findIdBySlug(context, input.orgSlug);
    if (!orgId) throw new NotFoundDomainError("org");

    // Permission cross-check beyond the guard: only owners can mint
    // owner-level invites. Guard ensures the caller is at least admin.
    const effectiveRole = callerOrgRole ?? (await this.resolveRole(orgId, userId));
    if (!effectiveRole) {
      throw new ForbiddenDomainError("not a member of this org");
    }
    if (input.role === "owner" && effectiveRole !== "owner") {
      throw new ForbiddenDomainError("only owners can mint owner invites");
    }

    if (input.email && input.maxUses) {
      throw new ValidationDomainError("targeted invites cannot set max_uses");
    }
    if (input.isOpen && input.email) {
      throw new ValidationDomainError("open invites must not target an email");
    }
    if (!input.email && !input.isOpen && input.maxUses === null) {
      // Caller didn't disambiguate — default to open when no email + no maxUses.
      input.isOpen = true;
    }
    if (input.maxUses !== null && input.maxUses <= 0) {
      throw new ValidationDomainError("max_uses must be positive");
    }
    if (input.expiresInDays <= 0 || input.expiresInDays > 365) {
      throw new ValidationDomainError("expires_in_days must be between 1 and 365");
    }

    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;

    const isOpen = input.isOpen || (!input.email && input.maxUses !== null);

    const createInput: CreateOrgInviteInput = {
      orgId,
      invitedBy: userId,
      email: input.email,
      role: input.role,
      isOpen,
      maxUses: isOpen ? input.maxUses : null,
      expiresAt,
      token,
    };
    const created = await this.inviteRepository.createOrgInvite(createInput);

    await this.auditService.writeFromContext(context, {
      actorKind: "user",
      orgId,
      action: "org.invite.created",
      resourceType: "org_invite",
      resourceId: created.id,
      after: {
        invite_id: created.id,
        email: input.email,
        role: input.role,
        mode: created.mode,
        is_open: isOpen,
        max_uses: createInput.maxUses,
        expires_at: created.expiresAt,
      },
    });

    return {
      inviteId: created.id,
      inviteUrl: this.buildInviteUrl(created.token),
      token: created.token,
      mode: created.mode,
      expiresAt: created.expiresAt,
      role: created.role,
      maxUses: created.maxUses,
    };
  }

  async list(context: ActorContext, orgSlug: string): Promise<ListedInvite[]> {
    const orgId = await this.orgRepository.findIdBySlug(context, orgSlug);
    if (!orgId) throw new NotFoundDomainError("org");
    const rows = await this.inviteRepository.listOrgInvites(orgId);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      mode: row.mode,
      expiresAt: row.expiresAt,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      createdAt: row.createdAt,
      inviteUrl: this.buildInviteUrl(row.token),
    }));
  }

  async revoke(context: ActorContext, inviteId: string): Promise<void> {
    // Capture pre-revoke state for the audit trail (before-image).
    const before = await this.db.query.orgInvites.findFirst({
      where: eq(orgInvites.id, inviteId),
    });
    await this.inviteRepository.revokeOrgInvite(inviteId);
    await this.auditService.writeFromContext(context, {
      actorKind: "user",
      orgId: before?.orgId ?? null,
      action: "org.invite.revoked",
      resourceType: "org_invite",
      resourceId: inviteId,
      before: before
        ? {
            id: before.id,
            org_id: before.orgId,
            email: before.email,
            role: before.role,
            is_open: before.isOpen,
            max_uses: before.maxUses,
            used_count: before.usedCount,
          }
        : null,
    });
  }

  preview(token: string): Promise<OrgInvitePreview | null> {
    return this.inviteRepository.findOrgInvitePreview(token);
  }

  async accept(context: ActorContext, token: string): Promise<AcceptOutcome> {
    const record = await this.inviteRepository.accept(context, token);
    if (record.kind !== "org" || !record.orgId) {
      throw new ValidationDomainError("project invites must use the legacy flow");
    }
    // Audit is best-effort. The membership write already committed in
    // `inviteRepository.accept` above; surfacing an audit failure as a
    // 500 to the caller is worse than missing a row in audit_log — the
    // user appears to fail but is actually a member. Catch + log so
    // the CLI / dashboard see the success they earned.
    try {
      await this.auditService.writeFromContext(context, {
        actorKind: "user",
        orgId: record.orgId,
        action: "org.invite.accepted",
        resourceType: "org_member",
        resourceId: context.principal.userId ?? null,
        after: {
          org_id: record.orgId,
          org_slug: record.orgSlug ?? "",
          role: record.role,
        },
      });
    } catch (err) {
      // Use Logger.warn so this still surfaces in cloudwatch but
      // doesn't propagate. AuditService failure is a real ops signal —
      // not silent, but not user-visible.
      // eslint-disable-next-line no-console
      console.warn(
        `[invites.accept] audit_log write failed for org=${record.orgId} user=${context.principal.userId} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {
      orgId: record.orgId,
      orgSlug: record.orgSlug ?? "",
      role: record.role as OrgRole,
    };
  }

  private buildInviteUrl(token: string): string {
    const base =
      this.configService.get<string>("OPENKT_DASHBOARD_URL") ?? "https://app.openkt.ai";
    return `${base.replace(/\/+$/, "")}/invite/${token}`;
  }

  private async resolveRole(orgId: string, userId: string): Promise<string | null> {
    const row = await this.db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)),
    });
    return row?.role ?? null;
  }
}
