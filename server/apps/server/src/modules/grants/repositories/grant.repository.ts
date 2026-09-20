import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { grants, pendingGrants, profiles, projects, sessions, skills, userCredentials } from "../../../db/schema";
import type {
  GrantRecord,
  GrantResourceType,
  GrantRole,
  GrantSubjectView,
  PendingGrantView,
} from "../contracts/grant.contract";

export interface ResourceOwnerLookup {
  ownerUserId: string;
  orgId: string | null;
  projectId: string | null;
}

@Injectable()
export class GrantRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Who owns a grantable resource, and which org (if any) it belongs to. The
  // one lookup behind "only the owner manages grants" and behind converting a
  // pending share — so a new resource type is added here once. `org` has no
  // single owner and is not shared through these routes.
  async findResourceOwner(
    resourceType: GrantResourceType,
    resourceId: string,
    db: Pick<DrizzleDb, "select"> = this.db,
  ): Promise<ResourceOwnerLookup | null> {
    const table =
      resourceType === "project" ? projects
      : resourceType === "session" ? sessions
      : resourceType === "skill" ? skills
      : null;
    if (!table) return null;
    // A deleted space — and a session in one — is not found (migration 0046).
    if (table === projects) {
      const [row] = await db
        .select({ ownerUserId: projects.ownerUserId, orgId: projects.orgId, projectId: projects.id })
        .from(projects)
        .where(and(eq(projects.id, resourceId), isNull(projects.deletedAt)))
        .limit(1);
      return row ?? null;
    }
    if (table === sessions) {
      const [row] = await db
        .select({ ownerUserId: sessions.ownerUserId, orgId: sessions.orgId, projectId: sessions.projectId })
        .from(sessions)
        .innerJoin(projects, eq(projects.id, sessions.projectId))
        .where(and(eq(sessions.id, resourceId), isNull(projects.deletedAt)))
        .limit(1);
      return row ?? null;
    }
    const [row] = await db
      .select({ ownerUserId: skills.ownerUserId, orgId: skills.orgId, projectId: skills.projectId })
      .from(skills)
      .where(eq(skills.id, resourceId))
      .limit(1);
    return row ?? null;
  }

  // The caller's own role on one resource, or null.
  async findUserRole(
    resourceType: GrantResourceType,
    resourceId: string,
    userId: string,
  ): Promise<GrantRole | null> {
    const [row] = await this.db
      .select({ role: grants.role })
      .from(grants)
      .where(
        and(
          eq(grants.resourceType, resourceType),
          eq(grants.resourceId, resourceId),
          eq(grants.subjectType, "user"),
          eq(grants.subjectId, userId),
        ),
      )
      .limit(1);
    return (row?.role as GrantRole | undefined) ?? null;
  }

  // Every role the caller holds on resources of one type, keyed by resource id.
  async listUserRoles(resourceType: GrantResourceType, userId: string): Promise<Map<string, GrantRole>> {
    const rows = await this.db
      .select({ resourceId: grants.resourceId, role: grants.role })
      .from(grants)
      .where(
        and(eq(grants.resourceType, resourceType), eq(grants.subjectType, "user"), eq(grants.subjectId, userId)),
      );
    return new Map(rows.map((r) => [r.resourceId, r.role as GrantRole]));
  }

  // Everything attached to a resource that is going away.
  async removeAllForResource(resourceType: GrantResourceType, resourceId: string): Promise<void> {
    await this.db
      .delete(grants)
      .where(and(eq(grants.resourceType, resourceType), eq(grants.resourceId, resourceId)));
    await this.db
      .delete(pendingGrants)
      .where(and(eq(pendingGrants.resourceType, resourceType), eq(pendingGrants.resourceId, resourceId)));
  }

  async list(resourceType: GrantResourceType, resourceId: string): Promise<GrantRecord[]> {
    const rows = await this.db
      .select()
      .from(grants)
      .where(and(eq(grants.resourceType, resourceType), eq(grants.resourceId, resourceId)))
      .orderBy(asc(grants.createdAt));
    return rows.map((row) => this.toRecord(row));
  }

  async put(
    resourceType: GrantResourceType,
    resourceId: string,
    orgId: string | null,
    subjectUserId: string,
    role: GrantRole,
    createdBy: string,
  ): Promise<GrantRecord> {
    const [row] = await this.db
      .insert(grants)
      .values({
        orgId,
        resourceType,
        resourceId,
        subjectType: "user",
        subjectId: subjectUserId,
        role,
        createdBy,
      })
      .onConflictDoUpdate({
        target: [grants.resourceType, grants.resourceId, grants.subjectType, grants.subjectId],
        set: { role, createdBy, createdAt: sql`now()` },
      })
      .returning();
    if (!row) throw new ValidationDomainError("grant create failed");
    return this.toRecord(row);
  }

  async remove(
    resourceType: GrantResourceType,
    resourceId: string,
    subjectUserId: string,
  ): Promise<boolean> {
    const result = await this.db
      .delete(grants)
      .where(
        and(
          eq(grants.resourceType, resourceType),
          eq(grants.resourceId, resourceId),
          eq(grants.subjectType, "user"),
          eq(grants.subjectId, subjectUserId),
        ),
      )
      .returning({ id: grants.id });
    return result.length > 0;
  }

  // Used by session-level recall/read access checks: does this user
  // hold ANY grant (reader or above) on this specific session?
  async hasSessionGrant(sessionId: string, userId: string): Promise<boolean> {
    const row = await this.db.query.grants.findFirst({
      where: and(
        eq(grants.resourceType, "session"),
        eq(grants.resourceId, sessionId),
        eq(grants.subjectType, "user"),
        eq(grants.subjectId, userId),
      ),
    });
    return !!row;
  }

  // ── share by email ────────────────────────────────────────────────

  // Who owns this (lower-cased) email? Built-in accounts are authoritative
  // (unique, lower-cased). Profiles created by another sign-in path (Supabase,
  // seeded test users) are matched only when exactly one carries the address,
  // so an ambiguous email never silently picks a person.
  async findUserIdByEmail(email: string): Promise<string | null> {
    const [credential] = await this.db
      .select({ userId: userCredentials.userId })
      .from(userCredentials)
      .where(eq(userCredentials.email, email))
      .limit(1);
    if (credential) return credential.userId;

    const matches = await this.db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(sql`lower(${profiles.email}) = ${email}`)
      .limit(2);
    return matches.length === 1 ? matches[0]!.userId : null;
  }

  async findSubjects(userIds: string[]): Promise<Map<string, GrantSubjectView>> {
    const out = new Map<string, GrantSubjectView>();
    if (userIds.length === 0) return out;
    const rows = await this.db
      .select({ userId: profiles.userId, email: profiles.email, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.userId, userIds));
    for (const row of rows) {
      out.set(row.userId, { id: row.userId, email: row.email, display_name: row.displayName });
    }
    return out;
  }

  async listPending(resourceType: GrantResourceType, resourceId: string): Promise<PendingGrantView[]> {
    const rows = await this.db
      .select()
      .from(pendingGrants)
      .where(and(eq(pendingGrants.resourceType, resourceType), eq(pendingGrants.resourceId, resourceId)))
      .orderBy(asc(pendingGrants.createdAt));
    return rows.map((row) => this.toPendingView(row));
  }

  async putPending(
    resourceType: GrantResourceType,
    resourceId: string,
    email: string,
    role: GrantRole,
    createdBy: string,
  ): Promise<PendingGrantView> {
    const [row] = await this.db
      .insert(pendingGrants)
      .values({ resourceType, resourceId, email, role, createdBy })
      .onConflictDoUpdate({
        target: [pendingGrants.resourceType, pendingGrants.resourceId, pendingGrants.email],
        set: { role, createdBy, createdAt: sql`now()` },
      })
      .returning();
    if (!row) throw new ValidationDomainError("pending grant create failed");
    return this.toPendingView(row);
  }

  async removePending(resourceType: GrantResourceType, resourceId: string, pendingId: string): Promise<boolean> {
    const result = await this.db
      .delete(pendingGrants)
      .where(
        and(
          eq(pendingGrants.id, pendingId),
          eq(pendingGrants.resourceType, resourceType),
          eq(pendingGrants.resourceId, resourceId),
        ),
      )
      .returning({ id: pendingGrants.id });
    return result.length > 0;
  }

  // A new account claims the shares that were waiting for its email: each
  // pending row becomes a real grant (never downgrading one that already
  // exists, never granting the owner a role on their own resource), then the
  // pending rows go. One transaction, so a share is never lost half-way.
  async convertPendingForEmail(email: string, userId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(pendingGrants).where(eq(pendingGrants.email, email)).returning();
      let converted = 0;
      for (const row of rows) {
        const resourceType = row.resourceType as GrantResourceType;
        const owner = await this.findResourceOwner(resourceType, row.resourceId, tx);
        // The resource was deleted while the share waited, or the new account IS the owner.
        if (!owner || owner.ownerUserId === userId) continue;
        const inserted = await tx
          .insert(grants)
          .values({
            orgId: owner.orgId,
            resourceType,
            resourceId: row.resourceId,
            subjectType: "user",
            subjectId: userId,
            role: row.role,
            createdBy: row.createdBy,
          })
          .onConflictDoNothing()
          .returning({ id: grants.id });
        converted += inserted.length;
      }
      return converted;
    });
  }

  private toPendingView(row: typeof pendingGrants.$inferSelect): PendingGrantView {
    return {
      id: row.id,
      resource_type: row.resourceType as PendingGrantView["resource_type"],
      resource_id: row.resourceId,
      pending: true,
      email: row.email,
      role: row.role as PendingGrantView["role"],
      created_by: row.createdBy,
      created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    };
  }

  private toRecord(row: typeof grants.$inferSelect): GrantRecord {
    return {
      id: row.id,
      org_id: row.orgId,
      resource_type: row.resourceType as GrantRecord["resource_type"],
      resource_id: row.resourceId,
      subject_type: "user",
      subject_id: row.subjectId,
      role: row.role as GrantRecord["role"],
      created_by: row.createdBy,
      created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    };
  }
}
