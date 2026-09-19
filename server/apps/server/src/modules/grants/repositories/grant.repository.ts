import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { grants, pendingGrants, profiles, projects, sessions, userCredentials } from "../../../db/schema";
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
}

@Injectable()
export class GrantRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async findProjectOwner(projectId: string): Promise<ResourceOwnerLookup | null> {
    const row = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      columns: { ownerUserId: true, orgId: true },
    });
    return row ? { ownerUserId: row.ownerUserId, orgId: row.orgId } : null;
  }

  async findSessionOwner(sessionId: string): Promise<ResourceOwnerLookup | null> {
    const row = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
      columns: { ownerUserId: true, orgId: true },
    });
    return row ? { ownerUserId: row.ownerUserId, orgId: row.orgId } : null;
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
        const owner =
          resourceType === "project"
            ? await tx.query.projects.findFirst({
                where: eq(projects.id, row.resourceId),
                columns: { ownerUserId: true, orgId: true },
              })
            : await tx.query.sessions.findFirst({
                where: eq(sessions.id, row.resourceId),
                columns: { ownerUserId: true, orgId: true },
              });
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
