import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray, sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { grants, orgMembers, projects } from "../../../db/schema";

export interface VisibleScope {
  // Every project the asker may read: owned, org-member, or holding a
  // direct project grant (or a grant on the project's org).
  projectIds: string[];
  // Sessions granted directly to the asker that are NOT already
  // covered by projectIds — the case a personal project's owner
  // shares exactly one session without opening the whole space.
  sessionIds: string[];
}

const EMPTY_SCOPE: VisibleScope = { projectIds: [], sessionIds: [] };

// architecture.md §3: "One guard resolves 'what can this principal
// see' once per request; services never re-implement it." This is
// that guard for the read/recall path — the write-side per-resource
// checks still go through ProjectScopeService.requireProjectAccess
// (owner/org-role) plus GrantsApplicationService (grant-role) for the
// mutations grants themselves gate.
//
// Deliberately its own module/service (not folded into
// ProjectScopeService): visibleScope() is a single batched read used
// by the hybrid-recall SQL to build a `WHERE project_id = ANY(...)`
// clause — the recall path cannot afford the N+1 shape
// requireProjectAccessuses per-project.
@Injectable()
export class AccessScopeService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async visibleScope(context: ActorContext): Promise<VisibleScope> {
    const userId = context.principal.userId;
    if (!userId) return EMPTY_SCOPE;

    const [owned, orgMember, projectGrants, orgGrants, sessionGrants] = await Promise.all([
      this.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.ownerUserId, userId)),
      this.db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(orgMembers, eq(orgMembers.orgId, projects.orgId))
        .where(eq(orgMembers.userId, userId)),
      this.db
        .select({ id: grants.resourceId })
        .from(grants)
        .where(
          sql`${grants.subjectType} = 'user' and ${grants.subjectId} = ${userId}::uuid and ${grants.resourceType} = 'project'`,
        ),
      this.db
        .select({ id: grants.resourceId })
        .from(grants)
        .where(
          sql`${grants.subjectType} = 'user' and ${grants.subjectId} = ${userId}::uuid and ${grants.resourceType} = 'org'`,
        ),
      this.db
        .select({ id: grants.resourceId })
        .from(grants)
        .where(
          sql`${grants.subjectType} = 'user' and ${grants.subjectId} = ${userId}::uuid and ${grants.resourceType} = 'session'`,
        ),
    ]);

    const orgGrantIds = orgGrants.map((r) => r.id);
    const orgGrantProjects = orgGrantIds.length
      ? await this.db
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.orgId, orgGrantIds))
      : [];

    const projectIds = Array.from(
      new Set([
        ...owned.map((r) => r.id),
        ...orgMember.map((r) => r.id),
        ...projectGrants.map((r) => r.id),
        ...orgGrantProjects.map((r) => r.id),
      ]),
    );

    return {
      projectIds,
      sessionIds: Array.from(new Set(sessionGrants.map((r) => r.id))),
    };
  }
}
