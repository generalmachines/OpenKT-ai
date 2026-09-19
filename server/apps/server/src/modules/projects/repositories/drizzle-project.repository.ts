import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import {
  NotFoundDomainError,
  ValidationDomainError,
} from "@openkt/core-errors";
import { requireProjectAccess } from "@openkt/auth-authorization";
import type {
  CreateProjectRecord,
  ProjectListFilters,
  ProjectRecord,
  ProjectRepository,
  ProjectRoleRecord,
} from "@openkt/data-repositories";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { orgMembers, orgs, projects } from "../../../db/schema";

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

    // Visibility rules: caller sees a project if they own it OR they
    // belong to its org. Implemented as a UNION-ish via two queries
    // (cheap; both are sub-100-row reads in practice).
    const ownedConditions = [eq(projects.ownerUserId, userId)];
    if (filters.orgId) ownedConditions.push(eq(projects.orgId, filters.orgId));
    if (filters.visibility) ownedConditions.push(eq(projects.visibility, filters.visibility));

    const owned = await this.db
      .select()
      .from(projects)
      .where(and(...ownedConditions))
      .orderBy(asc(projects.createdAt));

    const memberConditions = [eq(orgMembers.userId, userId)];
    if (filters.orgId) memberConditions.push(eq(projects.orgId, filters.orgId));
    if (filters.visibility) memberConditions.push(eq(projects.visibility, filters.visibility));

    const memberOf = await this.db
      .select({ p: projects })
      .from(projects)
      .innerJoin(orgMembers, eq(orgMembers.orgId, projects.orgId))
      .where(and(...memberConditions))
      .orderBy(asc(projects.createdAt));

    const seen = new Set<string>();
    const out: ProjectRecord[] = [];
    for (const row of [...owned, ...memberOf.map((r) => r.p)]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(this.toRecord(row));
    }
    return out;
  }

  async findById(_context: ActorContext, projectId: string): Promise<ProjectRecord | null> {
    const row = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    return row ? this.toRecord(row) : null;
  }

  async findBySlug(
    context: ActorContext,
    accountSlug: string,
    projectSlug: string,
  ): Promise<ProjectRecord | null> {
    const org = await this.db.query.orgs.findFirst({ where: eq(orgs.slug, accountSlug) });
    if (!org) return null;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.orgId, org.id), eq(projects.slug, projectSlug)),
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

    // No project_members table in the schema (yet) — fall back to org
    // role only. Future work: add per-project ACL when needed.
    if (project.orgId) {
      const member = await this.db.query.orgMembers.findFirst({
        where: and(eq(orgMembers.orgId, project.orgId), eq(orgMembers.userId, userId)),
      });
      const role = member?.role;
      if (role && ["owner", "admin", "member"].includes(role)) {
        return role === "member" ? "viewer" : "admin";
      }
    }
    return null;
  }

  private toRecord(row: typeof projects.$inferSelect): ProjectRecord {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      visibility: row.visibility as ProjectRecord["visibility"],
      orgId: row.orgId,
      ownerUserId: row.ownerUserId,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
    };
  }

  private iso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d);
  }
}
