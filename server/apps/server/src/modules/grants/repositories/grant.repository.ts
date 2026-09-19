import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";

import { ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { grants, projects, sessions } from "../../../db/schema";
import type { GrantRecord, GrantResourceType, GrantRole } from "../contracts/grant.contract";

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
