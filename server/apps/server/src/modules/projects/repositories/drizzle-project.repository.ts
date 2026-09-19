import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import {
  NotFoundDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";
import { requireProjectAccess } from "@openkt/auth-authorization";
import type {
  CreateProjectRecord,
  ProjectListFilters,
  ProjectMemberRecord,
  ProjectRecord,
  ProjectRepository,
  ProjectRoleRecord,
  UpdateProjectRecord,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import {
  grants,
  jobs,
  joinLinks,
  memories,
  orgMembers,
  orgs,
  pendingGrants,
  profiles,
  projects,
  sessions,
} from "../../../db/schema";

@Injectable()
export class DrizzleProjectRepository implements ProjectRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(context: ActorContext, input: CreateProjectRecord): Promise<ProjectRecord> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");
    const [created] = await this.db
      .insert(projects)
      .values({
        slug: input.slug,
        name: input.name,
        visibility: input.visibility,
        orgId: input.orgId,
        ownerUserId: userId,
        description: input.description ?? null,
      })
      .returning()
      .catch((err: Error) => {
        if (/duplicate key value/.test(err.message)) {
          throw new ValidationDomainError("project slug already exists");
        }
        throw new ValidationDomainError(err.message);
      });
    if (!created) throw new ValidationDomainError("project create failed");
    return this.toRecord(created);
  }

  async listVisible(
    context: ActorContext,
    filters: ProjectListFilters,
  ): Promise<ProjectRecord[]> {
    const userId = context.principal.userId;
    if (!userId) return [];

    // Visibility rules: caller sees a project if they own it, belong to
    // its org, OR hold a grant on it (a space shared with them). Implemented as a UNION-ish via two queries
    // (cheap; both are sub-100-row reads in practice).
    const ownedConditions = [eq(projects.ownerUserId, userId), isNull(projects.deletedAt)];
    if (filters.orgId) ownedConditions.push(eq(projects.orgId, filters.orgId));
    if (filters.visibility) ownedConditions.push(eq(projects.visibility, filters.visibility));

    const owned = await this.db
      .select()
      .from(projects)
      .where(and(...ownedConditions))
      .orderBy(asc(projects.createdAt));

    const memberConditions = [eq(orgMembers.userId, userId), isNull(projects.deletedAt)];
    if (filters.orgId) memberConditions.push(eq(projects.orgId, filters.orgId));
    if (filters.visibility) memberConditions.push(eq(projects.visibility, filters.visibility));

    const memberOf = await this.db
      .select({ p: projects })
      .from(projects)
      .innerJoin(orgMembers, eq(orgMembers.orgId, projects.orgId))
      .where(and(...memberConditions))
      .orderBy(asc(projects.createdAt));

    const grantedConditions = [
      isNull(projects.deletedAt),
      eq(grants.resourceType, "project"),
      eq(grants.subjectType, "user"),
      eq(grants.subjectId, userId),
    ];
    if (filters.orgId) grantedConditions.push(eq(projects.orgId, filters.orgId));
    if (filters.visibility) grantedConditions.push(eq(projects.visibility, filters.visibility));

    const granted = await this.db
      .select({ p: projects })
      .from(projects)
      .innerJoin(grants, eq(grants.resourceId, projects.id))
      .where(and(...grantedConditions))
      .orderBy(asc(projects.createdAt));

    const seen = new Set<string>();
    const out: ProjectRecord[] = [];
    for (const row of [...owned, ...memberOf.map((r) => r.p), ...granted.map((r) => r.p)]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(this.toRecord(row));
    }
    return out;
  }

  async findById(_context: ActorContext, projectId: string): Promise<ProjectRecord | null> {
    const row = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), isNull(projects.deletedAt)),
    });
    return row ? this.toRecord(row) : null;
  }

  async update(projectId: string, patch: UpdateProjectRecord): Promise<ProjectRecord | null> {
    const [row] = await this.db
      .update(projects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .returning();
    return row ? this.toRecord(row) : null;
  }

  // Owner first, then editors, then readers (by name): the owner, direct
  // grants on the space, and — for an org space — the org's members.
  async listMembers(projectId: string): Promise<ProjectMemberRecord[]> {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), isNull(projects.deletedAt)),
    });
    if (!project) return [];
    const roles = new Map<string, ProjectMemberRecord["role"]>([[project.ownerUserId, "owner"]]);
    const rank = { owner: 3, editor: 2, reader: 1 } as const;
    const keep = (userId: string, role: ProjectMemberRecord["role"]) => {
      const had = roles.get(userId);
      if (!had || rank[role] > rank[had]) roles.set(userId, role);
    };
    const granted = await this.db
      .select({ userId: grants.subjectId, role: grants.role })
      .from(grants)
      .where(
        and(eq(grants.resourceType, "project"), eq(grants.resourceId, projectId), eq(grants.subjectType, "user")),
      );
    // An owner grant reads as editor: only the literal owner is `owner`.
    for (const g of granted) keep(g.userId, g.role === "reader" ? "reader" : "editor");
    if (project.orgId) {
      const members = await this.db
        .select({ userId: orgMembers.userId, role: orgMembers.role })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, project.orgId));
      for (const m of members) {
        if (m.role === "owner" || m.role === "admin") keep(m.userId, "editor");
        else if (m.role === "member") keep(m.userId, "reader");
      }
    }
    const names = await this.db
      .select({ userId: profiles.userId, name: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.userId, [...roles.keys()]));
    const nameOf = new Map(names.map((n) => [n.userId, n.name]));
    return [...roles.entries()]
      .map(([userId, role]) => ({ userId, displayName: nameOf.get(userId) ?? null, role }))
      .sort((a, b) => rank[b.role] - rank[a.role] || (a.displayName ?? "").localeCompare(b.displayName ?? ""));
  }

  // DELETE /v1/projects/:id: the row stays (nothing is destroyed), but the
  // space is gone from every read (`deleted_at`), its facts are archived so
  // they leave recall, its shares, pending shares, join links and queued jobs
  // go, and its open sessions close.
  async softDelete(projectId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await tx
        .update(memories)
        .set({ archived: true, updatedAt: new Date() })
        .where(and(eq(memories.projectId, projectId), eq(memories.archived, false)));
      const sessionIds = sql`(select ${sessions.id} from ${sessions} where ${sessions.projectId} = ${projectId}::uuid)`;
      await tx
        .delete(grants)
        .where(
          sql`(${grants.resourceType} = 'project' and ${grants.resourceId} = ${projectId}::uuid)
           or (${grants.resourceType} = 'session' and ${grants.resourceId} in ${sessionIds})`,
        );
      await tx
        .delete(pendingGrants)
        .where(
          sql`(${pendingGrants.resourceType} = 'project' and ${pendingGrants.resourceId} = ${projectId}::uuid)
           or (${pendingGrants.resourceType} = 'session' and ${pendingGrants.resourceId} in ${sessionIds})`,
        );
      await tx.delete(joinLinks).where(eq(joinLinks.projectId, projectId));
      await tx.delete(jobs).where(and(eq(jobs.projectId, projectId), eq(jobs.status, "queued")));
      await tx
        .update(sessions)
        .set({ status: "closed", endedAt: sql`coalesce(${sessions.endedAt}, now())`, updatedAt: sql`now()` })
        .where(and(eq(sessions.projectId, projectId), eq(sessions.status, "open")));
    });
  }

  async findBySlug(
    context: ActorContext,
    accountSlug: string,
    projectSlug: string,
  ): Promise<ProjectRecord | null> {
    const org = await this.db.query.orgs.findFirst({ where: eq(orgs.slug, accountSlug) });
    if (!org) return null;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.orgId, org.id), eq(projects.slug, projectSlug), isNull(projects.deletedAt)),
    });
    if (!project) return null;
    try {
      await requireProjectAccess(context, project.id, "read");
    } catch (err) {
      if (err instanceof NotFoundDomainError) return null;
      throw err;
    }
    return this.toRecord(project);
  }

  async findViewerRole(
    context: ActorContext,
    projectId: string,
  ): Promise<ProjectRoleRecord["role"]> {
    const userId = context.principal.userId;
    if (!userId) return null;

    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) return null;
    if (project.ownerUserId === userId) return "owner";

    // A grant on the space: owner → admin, editor → member, reader → viewer.
    const grant = await this.db.query.grants.findFirst({
      where: and(
        eq(grants.resourceType, "project"),
        eq(grants.resourceId, projectId),
        eq(grants.subjectType, "user"),
        eq(grants.subjectId, userId),
      ),
    });
    const fromGrant =
      grant?.role === "owner" ? "admin" : grant?.role === "editor" ? "member" : grant?.role === "reader" ? "viewer" : null;

    if (project.orgId) {
      const member = await this.db.query.orgMembers.findFirst({
        where: and(eq(orgMembers.orgId, project.orgId), eq(orgMembers.userId, userId)),
      });
      const role = member?.role;
      if (role && ["owner", "admin", "member"].includes(role)) {
        const fromOrg = role === "member" ? "viewer" : "admin";
        // The stronger of the two wins.
        const rank = { admin: 3, member: 2, viewer: 1 } as const;
        return fromGrant && rank[fromGrant] > rank[fromOrg] ? fromGrant : fromOrg;
      }
    }
    return fromGrant;
  }

  private toRecord(row: typeof projects.$inferSelect): ProjectRecord {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      visibility: row.visibility as ProjectRecord["visibility"],
      orgId: row.orgId,
      ownerUserId: row.ownerUserId,
      isPersonal: row.isPersonal,
      description: row.description ?? null,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
    };
  }

  private iso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d);
  }
}
