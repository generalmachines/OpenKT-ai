import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { grants, orgMembers, orgs, projects } from "../../../db/schema";

const LEGACY_PROJECT_ID_RE = /^prj_/i;
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

@Injectable()
export class ProjectScopeService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async resolvePersonalProjectId(context: ActorContext): Promise<string> {
    const userId = context.principal.userId;
    if (!userId) {
      throw new ValidationDomainError("user principal required");
    }

    const existing = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.ownerUserId, userId),
          eq(projects.visibility, "personal"),
          isNull(projects.orgId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return existing[0].id;
    }

    const [created] = await this.db
      .insert(projects)
      .values({
        slug: "personal",
        name: "Personal",
        visibility: "personal",
        orgId: null,
        ownerUserId: userId,
      })
      .returning({ id: projects.id })
      .catch((err: Error) => {
        throw new ValidationDomainError(err.message);
      });

    if (!created) throw new ValidationDomainError("personal project create failed");
    return created.id;
  }

  async resolveProjectIdOrSlug(
    context: ActorContext,
    rawProjectId: string | null | undefined,
  ): Promise<string> {
    if (!rawProjectId || !rawProjectId.trim()) {
      return this.resolvePersonalProjectId(context);
    }

    const value = rawProjectId.trim();
    if (LEGACY_PROJECT_ID_RE.test(value)) {
      throw new ValidationDomainError(
        "stale legacy project_id (prj_*). Re-run initialization to refresh the manifest.",
      );
    }

    if (this.isUuid(value)) {
      return value;
    }

    if (value.includes("/")) {
      const [accountSlug, projectSlug, ...rest] = value.split("/");
      if (rest.length > 0 || !accountSlug || !projectSlug) {
        throw new ValidationDomainError(
          "project_id slug form must be `<account_slug>/<project_slug>`",
        );
      }

      const org = await this.db.query.orgs.findFirst({
        where: eq(orgs.slug, accountSlug),
      });
      if (!org) {
        throw new NotFoundDomainError("project");
      }

      const project = await this.db.query.projects.findFirst({
        where: and(eq(projects.orgId, org.id), eq(projects.slug, projectSlug)),
      });
      if (!project) {
        throw new NotFoundDomainError("project");
      }

      await this.requireProjectAccess(context, project.id, "read");
      return project.id;
    }

    if (!PROJECT_SLUG_RE.test(value)) {
      throw new ValidationDomainError(
        "project_id must be a UUID, a `<account>/<project>` slug pair, or a bare project slug",
      );
    }

    const userId = context.principal.userId;
    if (!userId) {
      throw new ValidationDomainError("user principal required");
    }

    const personalMatch = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.ownerUserId, userId),
          eq(projects.slug, value),
          isNull(projects.orgId),
        ),
      )
      .limit(1);
    if (personalMatch[0]) return personalMatch[0].id;

    const orgMatch = await this.db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(orgMembers, eq(orgMembers.orgId, projects.orgId))
      .where(and(eq(projects.slug, value), eq(orgMembers.userId, userId)))
      .limit(1);
    if (orgMatch[0]) return orgMatch[0].id;

    throw new NotFoundDomainError("project");
  }

  async requireProjectAccess(
    context: ActorContext,
    projectId: string,
    mode: "read" | "write" | "admin",
  ): Promise<{ projectId: string; orgId: string | null; ownerUserId: string; role: string }> {
    const userId = context.principal.userId;
    if (!userId) throw new ValidationDomainError("user principal required");

    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) throw new NotFoundDomainError("project");

    if (project.ownerUserId === userId) {
      return {
        projectId: project.id,
        orgId: project.orgId,
        ownerUserId: project.ownerUserId,
        role: "owner",
      };
    }

    if (project.orgId) {
      const member = await this.db.query.orgMembers.findFirst({
        where: and(eq(orgMembers.orgId, project.orgId), eq(orgMembers.userId, userId)),
      });
      if (member?.role && this.orgRoleAllows(member.role, mode)) {
        return {
          projectId: project.id,
          orgId: project.orgId,
          ownerUserId: project.ownerUserId,
          role: member.role,
        };
      }
    }

    // grants (migration 0038) — a direct grant on the project, or on
    // the project's org, is the real project_members-equivalent
    // architecture.md §3 calls for. Mirrors
    // libs/auth/authorization/src/access-policy.ts's requireProjectAccess
    // (this method predates that shared lib and several call sites —
    // MemoryCommandsApplicationService.create, SessionsApplicationService
    // — still go through it directly).
    const grantRows = await this.db
      .select({ role: grants.role })
      .from(grants)
      .where(
        and(
          eq(grants.subjectType, "user"),
          eq(grants.subjectId, userId),
          project.orgId
            ? or(
                and(eq(grants.resourceType, "project"), eq(grants.resourceId, project.id)),
                and(eq(grants.resourceType, "org"), eq(grants.resourceId, project.orgId)),
              )
            : and(eq(grants.resourceType, "project"), eq(grants.resourceId, project.id)),
        ),
      );
    const grantRank: Record<string, number> = { reader: 1, editor: 2, owner: 3 };
    const bestGrant = grantRows.reduce<string | null>((best, row) => {
      if (!best) return row.role;
      return (grantRank[row.role] ?? 0) > (grantRank[best] ?? 0) ? row.role : best;
    }, null);
    if (bestGrant && this.grantRoleAllows(bestGrant, mode)) {
      return {
        projectId: project.id,
        orgId: project.orgId,
        ownerUserId: project.ownerUserId,
        role: bestGrant,
      };
    }

    throw new NotFoundDomainError("project");
  }

  private orgRoleAllows(role: string, mode: "read" | "write" | "admin"): boolean {
    if (mode === "read") return ["owner", "admin", "member"].includes(role);
    return ["owner", "admin"].includes(role);
  }

  private grantRoleAllows(role: string, mode: "read" | "write" | "admin"): boolean {
    if (mode === "read") return ["reader", "editor", "owner"].includes(role);
    if (mode === "write") return ["editor", "owner"].includes(role);
    return role === "owner";
  }

  async workspaceRing(context: ActorContext, primaryProjectId: string): Promise<string[]> {
    const userId = context.principal.userId;
    if (!userId) return [];

    const primary = await this.db.query.projects.findFirst({
      where: eq(projects.id, primaryProjectId),
    });
    if (!primary) return [];

    if (primary.visibility === "org" && primary.orgId) {
      const siblings = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, primary.orgId),
            eq(projects.visibility, "org"),
          ),
        );
      return siblings.map((row) => row.id).filter((id) => id !== primaryProjectId);
    }

    if (primary.visibility === "personal") {
      const siblings = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.ownerUserId, userId),
            eq(projects.visibility, "personal"),
            isNull(projects.orgId),
          ),
        );
      return siblings.map((row) => row.id).filter((id) => id !== primaryProjectId);
    }

    return [];
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
  }
}
