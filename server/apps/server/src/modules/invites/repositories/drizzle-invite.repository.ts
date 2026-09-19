import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import {
  ForbiddenDomainError,
  GoneDomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";
import type {
  AcceptedInviteRecord,
  CreateOrgInviteInput,
  InviteMode,
  InviteRepository,
  OrgInvitePreview,
  OrgInviteSummary,
  OrgRole,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  orgInviteRedemptions,
  orgInvites,
  orgMembers,
  orgs,
  profiles,
  projectInvites,
  projectMembers,
  projects,
} from "../../../db/schema";

// Single repository handling both org invites (targeted + open-link)
// and the legacy project invite flow. The accept() path stays the
// entry point used by `/v1/invites/accept`.

@Injectable()
export class DrizzleInviteRepository implements InviteRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async createOrgInvite(input: CreateOrgInviteInput): Promise<OrgInviteSummary> {
    // Profile prime: the prod DB has a FK from org_invites.invited_by
    // → profiles.user_id (declared via raw SQL, not in the drizzle
    // schema). Newly-signed-up users may not have a profile row yet if
    // they only just got their first Supabase JWT — insert one
    // idempotently so the FK never blows up the invite flow.
    await this.db
      .insert(profiles)
      .values({ userId: input.invitedBy })
      .onConflictDoNothing({ target: profiles.userId });

    const [row] = await this.db
      .insert(orgInvites)
      .values({
        orgId: input.orgId,
        invitedBy: input.invitedBy,
        email: input.email,
        role: input.role,
        token: input.token,
        expiresAt: input.expiresAt,
        isOpen: input.isOpen,
        maxUses: input.maxUses,
      })
      .returning();
    if (!row) throw new ValidationDomainError("invite create failed");
    return toSummary(row);
  }

  async listOrgInvites(orgId: string): Promise<OrgInviteSummary[]> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(orgInvites)
      .where(
        and(
          eq(orgInvites.orgId, orgId),
          isNull(orgInvites.revokedAt),
          gt(orgInvites.expiresAt, now),
          // Targeted invites: hide once accepted. Open invites:
          // hide once max_uses is reached.
          or(
            // targeted -> not yet accepted
            and(eq(orgInvites.isOpen, false), isNull(orgInvites.acceptedAt)),
            // open with no cap
            and(eq(orgInvites.isOpen, true), isNull(orgInvites.maxUses)),
            // open under cap
            and(
              eq(orgInvites.isOpen, true),
              sql`${orgInvites.maxUses} is not null and ${orgInvites.usedCount} < ${orgInvites.maxUses}`,
            ),
          ),
        ),
      )
      .orderBy(desc(orgInvites.createdAt));
    return rows.map(toSummary);
  }

  async revokeOrgInvite(inviteId: string): Promise<void> {
    await this.db
      .update(orgInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(orgInvites.id, inviteId), isNull(orgInvites.revokedAt)));
  }

  async findOrgInvitePreview(token: string): Promise<OrgInvitePreview | null> {
    const rows = await this.db
      .select({
        orgId: orgInvites.orgId,
        orgName: orgs.name,
        role: orgInvites.role,
        invitedByName: profiles.displayName,
        isOpen: orgInvites.isOpen,
        maxUses: orgInvites.maxUses,
        usedCount: orgInvites.usedCount,
        expiresAt: orgInvites.expiresAt,
        revokedAt: orgInvites.revokedAt,
        acceptedAt: orgInvites.acceptedAt,
      })
      .from(orgInvites)
      .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
      .leftJoin(profiles, eq(profiles.userId, orgInvites.invitedBy))
      .where(eq(orgInvites.token, token))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    // Targeted invites: hidden once consumed.
    if (!row.isOpen && row.acceptedAt) return null;
    // Open invites: hidden once maxed out.
    if (row.isOpen && row.maxUses !== null && row.usedCount >= row.maxUses) {
      return null;
    }

    const remainingUses =
      row.isOpen && row.maxUses !== null ? Math.max(row.maxUses - row.usedCount, 0) : null;

    return {
      orgId: row.orgId,
      orgName: row.orgName,
      role: row.role as OrgRole,
      invitedByName: row.invitedByName ?? null,
      mode: (row.isOpen ? "open" : "targeted") as InviteMode,
      expiresAt: row.expiresAt.toISOString(),
      remainingUses,
    };
  }

  async findOrgIdForInvite(inviteId: string): Promise<string | null> {
    const row = await this.db.query.orgInvites.findFirst({
      where: eq(orgInvites.id, inviteId),
    });
    return row?.orgId ?? null;
  }

  async findOrgIdForToken(token: string): Promise<string | null> {
    const row = await this.db.query.orgInvites.findFirst({
      where: eq(orgInvites.token, token),
    });
    return row?.orgId ?? null;
  }

  async accept(context: ActorContext, token: string): Promise<AcceptedInviteRecord> {
    const userId = context.principal.userId;
    const email = (context.principal.email ?? "").toLowerCase();
    if (!userId) {
      throw new ValidationDomainError("invite acceptance requires a signed-in user");
    }

    const orgInvite = await this.db.query.orgInvites.findFirst({
      where: eq(orgInvites.token, token),
    });
    if (orgInvite) {
      return this.acceptOrgInvite(orgInvite, userId, email);
    }

    const projectInvite = await this.db.query.projectInvites.findFirst({
      where: eq(projectInvites.token, token),
    });
    if (!projectInvite) throw new NotFoundDomainError("invite");

    if (projectInvite.acceptedAt) {
      return {
        kind: "project",
        projectId: projectInvite.projectId,
        role: projectInvite.role as AcceptedInviteRecord["role"],
      };
    }
    if (!email) {
      throw new ValidationDomainError("invite acceptance requires a signed-in user with email");
    }
    if (email !== projectInvite.email.toLowerCase()) {
      throw new ForbiddenDomainError("invite is for a different email");
    }

    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectInvite.projectId),
    });
    if (project?.orgId) {
      await this.db
        .insert(orgMembers)
        .values({ orgId: project.orgId, userId, role: "viewer", invitedBy: null })
        .onConflictDoNothing();
    }
    await this.db
      .insert(projectMembers)
      .values({
        projectId: projectInvite.projectId,
        userId,
        role: projectInvite.role,
        invitedBy: projectInvite.invitedBy,
      })
      .onConflictDoNothing();
    await this.db
      .update(projectInvites)
      .set({ acceptedAt: new Date(), acceptedBy: userId })
      .where(eq(projectInvites.id, projectInvite.id));

    return {
      kind: "project",
      projectId: projectInvite.projectId,
      role: projectInvite.role as AcceptedInviteRecord["role"],
    };
  }

  private async acceptOrgInvite(
    invite: typeof orgInvites.$inferSelect,
    userId: string,
    email: string,
  ): Promise<AcceptedInviteRecord> {
    if (invite.revokedAt) {
      throw new GoneDomainError("invite revoked");
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new GoneDomainError("invite expired");
    }

    // If the caller is already in the org, treat as a no-op.
    const existing = await this.db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, invite.orgId), eq(orgMembers.userId, userId)),
    });
    if (existing) {
      const orgSlug = await this.findOrgSlug(invite.orgId);
      return {
        kind: "org",
        orgId: invite.orgId,
        orgSlug,
        role: existing.role as AcceptedInviteRecord["role"],
      };
    }

    if (invite.isOpen) {
      // Open-link invite: redemption tracked per user; capped at max_uses.
      const alreadyRedeemed = await this.db.query.orgInviteRedemptions.findFirst({
        where: and(
          eq(orgInviteRedemptions.inviteId, invite.id),
          eq(orgInviteRedemptions.userId, userId),
        ),
      });
      if (alreadyRedeemed) {
        // The membership row may have been removed between redemption
        // and re-accept — reinstate it, no usedCount bump.
        await this.upsertMembership(invite, userId);
        const orgSlug = await this.findOrgSlug(invite.orgId);
        return {
          kind: "org",
          orgId: invite.orgId,
          orgSlug,
          role: invite.role as AcceptedInviteRecord["role"],
        };
      }

      // Atomically bump usedCount only if it's under the cap. The CTE
      // returns the updated row only when the bump succeeded.
      const updated = await this.db
        .update(orgInvites)
        .set({ usedCount: sql`${orgInvites.usedCount} + 1` })
        .where(
          and(
            eq(orgInvites.id, invite.id),
            isNull(orgInvites.revokedAt),
            gt(orgInvites.expiresAt, new Date()),
            or(
              isNull(orgInvites.maxUses),
              lt(orgInvites.usedCount, orgInvites.maxUses),
            ),
          ),
        )
        .returning();
      if (updated.length === 0) {
        throw new GoneDomainError("invite at max uses");
      }

      await this.db.insert(orgInviteRedemptions).values({
        inviteId: invite.id,
        userId,
      }).onConflictDoNothing();
      await this.upsertMembership(invite, userId);
      const orgSlug = await this.findOrgSlug(invite.orgId);
      return {
        kind: "org",
        orgId: invite.orgId,
        orgSlug,
        role: invite.role as AcceptedInviteRecord["role"],
      };
    }

    // Targeted invite path.
    if (invite.acceptedAt) {
      // Already consumed by someone — if the caller happens to be that
      // user, treat as idempotent; otherwise 410.
      if (invite.acceptedBy === userId) {
        // Reinstate membership in case it was removed between the
        // original accept and this re-accept. Mirrors the open-link
        // `alreadyRedeemed` branch above — without this an admin who
        // boots a member and then watches them re-click the link sees
        // a 200 + slug but no row in org_members.
        await this.upsertMembership(invite, userId);
        const orgSlug = await this.findOrgSlug(invite.orgId);
        return {
          kind: "org",
          orgId: invite.orgId,
          orgSlug,
          role: invite.role as AcceptedInviteRecord["role"],
        };
      }
      throw new GoneDomainError("invite already consumed");
    }
    if (invite.email) {
      if (!email) {
        throw new ValidationDomainError(
          "invite acceptance requires a signed-in user with email",
        );
      }
      if (email !== invite.email.toLowerCase()) {
        throw new ForbiddenDomainError("invite is for a different email");
      }
    }

    await this.upsertMembership(invite, userId);
    await this.db
      .update(orgInvites)
      .set({ acceptedAt: new Date(), acceptedBy: userId, usedCount: sql`${orgInvites.usedCount} + 1` })
      .where(eq(orgInvites.id, invite.id));

    const orgSlug = await this.findOrgSlug(invite.orgId);
    return {
      kind: "org",
      orgId: invite.orgId,
      orgSlug,
      role: invite.role as AcceptedInviteRecord["role"],
    };
  }

  private async upsertMembership(
    invite: typeof orgInvites.$inferSelect,
    userId: string,
  ): Promise<void> {
    await this.db
      .insert(orgMembers)
      .values({
        orgId: invite.orgId,
        userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      })
      .onConflictDoNothing();
  }

  private async findOrgSlug(orgId: string): Promise<string | undefined> {
    const row = await this.db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
    return row?.slug;
  }
}

function toSummary(row: typeof orgInvites.$inferSelect): OrgInviteSummary {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role as OrgRole,
    mode: (row.isOpen ? "open" : "targeted") as InviteMode,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    invitedBy: row.invitedBy,
    token: row.token,
  };
}
