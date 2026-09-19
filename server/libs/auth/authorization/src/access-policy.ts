import type { ActorContext } from "@openkt/core-context";
import {
  ForbiddenDomainError,
  NotFoundDomainError,
  UnauthorizedDomainError,
} from "@openkt/core-errors";
import { Pool } from "pg";

import type {
  MemoryAccess,
  OrgAccess,
  OrgAccessMode,
  ProjectAccess,
  ProjectAccessMode,
} from "./access.types";

function actorUserId(context: ActorContext): string {
  const userId = context.principal.userId;
  if (!userId) {
    throw new UnauthorizedDomainError("user principal required");
  }
  return userId;
}

let localPool: Pool | null | undefined;

function getLocalPool(): Pool | null {
  if (localPool !== undefined) return localPool;
  const connectionString = process.env.DATABASE_URL;
  localPool = connectionString ? new Pool({ connectionString }) : null;
  return localPool;
}

async function localQuery<T extends Record<string, unknown>>(
  text: string,
  values: unknown[],
): Promise<T[]> {
  const pool = getLocalPool();
  if (!pool) return [];
  try {
    const result = await pool.query<T>(text, values);
    return result.rows;
  } catch (err) {
    throw new ForbiddenDomainError(
      `local access resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function projectRoleSatisfies(role: string, mode: ProjectAccessMode): boolean {
  if (mode === "read") return ["admin", "member", "viewer"].includes(role);
  if (mode === "write") return ["admin", "member"].includes(role);
  return role === "admin";
}

function orgRoleSatisfiesProject(role: string, mode: ProjectAccessMode): boolean {
  if (mode === "read") return ["owner", "admin", "member"].includes(role);
  return ["owner", "admin"].includes(role);
}

// grants (migration 0038) role vocabulary — reader/editor/owner —
// distinct from the org_members/project_members vocabulary above.
function grantRoleSatisfies(role: string, mode: ProjectAccessMode): boolean {
  if (mode === "read") return ["reader", "editor", "owner"].includes(role);
  if (mode === "write") return ["editor", "owner"].includes(role);
  return role === "owner";
}

function grantRank(role: string): number {
  return { reader: 1, editor: 2, owner: 3 }[role] ?? 0;
}

// Highest grants role a user holds on a project: a direct grant on
// the project, OR a grant on the project's org (if any), whichever is
// stronger. Returns null when neither exists.
async function localGrantRole(
  resourceType: "project",
  resourceId: string,
  orgId: string | null,
  userId: string,
): Promise<string | null> {
  const rows = await localQuery<{ role: string }>(
    orgId
      ? `select role from grants
           where subject_type = 'user' and subject_id = $1
             and (
               (resource_type = $2 and resource_id = $3)
               or (resource_type = 'org' and resource_id = $4)
             )`
      : `select role from grants
           where subject_type = 'user' and subject_id = $1
             and resource_type = $2 and resource_id = $3`,
    orgId ? [userId, resourceType, resourceId, orgId] : [userId, resourceType, resourceId],
  );
  if (rows.length === 0) return null;
  return rows.reduce<string | null>((best, row) => {
    if (!best) return row.role;
    return grantRank(row.role) > grantRank(best) ? row.role : best;
  }, null);
}

export async function requireOrgAccess(
  context: ActorContext,
  orgId: string,
  mode: OrgAccessMode,
): Promise<OrgAccess> {
  const userId = actorUserId(context);
  const local = getLocalPool();
  if (local) {
    const [row] = await localQuery<{ role: OrgAccess["role"] }>(
      `
        select role
        from org_members
        where org_id = $1 and user_id = $2
        union all
        select 'owner'::text as role
        from orgs
        where id = $1 and created_by = $2
        limit 1
      `,
      [orgId, userId],
    );
    const role = row?.role;
    if (!role) throw new NotFoundDomainError("org");
    if (mode === "admin" && !["owner", "admin"].includes(role)) {
      throw new ForbiddenDomainError("admin role required");
    }
    return { orgId, role };
  }

  const { data, error } = await context.sb
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new ForbiddenDomainError(`org access resolution failed: ${error.message}`);
  }

  const role = (data as { role: OrgAccess["role"] } | null)?.role;
  if (!role) {
    throw new NotFoundDomainError("org");
  }

  if (mode === "admin" && !["owner", "admin"].includes(role)) {
    throw new ForbiddenDomainError("admin role required");
  }

  return { orgId, role };
}

export async function requireProjectAccess(
  context: ActorContext,
  projectId: string,
  mode: ProjectAccessMode,
): Promise<ProjectAccess> {
  const userId = actorUserId(context);
  const local = getLocalPool();
  if (local) {
    const [projectRow] = await localQuery<{
      id: string;
      org_id: string | null;
      owner_user_id: string;
      visibility: string;
    }>(
      "select id, org_id, owner_user_id, visibility from projects where id = $1 limit 1",
      [projectId],
    );
    if (!projectRow) throw new NotFoundDomainError("project");

    if (projectRow.owner_user_id === userId) {
      return {
        projectId: projectRow.id,
        orgId: projectRow.org_id,
        ownerUserId: projectRow.owner_user_id,
        visibility: projectRow.visibility,
        role: "owner",
      };
    }

    if (projectRow.org_id) {
      const [orgMembership] = await localQuery<{ role: string }>(
        "select role from org_members where org_id = $1 and user_id = $2 limit 1",
        [projectRow.org_id, userId],
      );
      const orgRole = orgMembership?.role;
      if (orgRole && orgRoleSatisfiesProject(orgRole, mode)) {
        return {
          projectId: projectRow.id,
          orgId: projectRow.org_id,
          ownerUserId: projectRow.owner_user_id,
          visibility: projectRow.visibility,
          role: orgRole === "member" ? "org_member" : "org_admin",
        };
      }
    }

    // The `grants` table (migration 0038) is the real
    // `project_members`-equivalent architecture.md §3 calls for: a
    // direct grant on the project, or a grant on the project's org,
    // either of which can satisfy read/write/admin the same way a
    // project_members row would have.
    const grantRole = await localGrantRole(
      "project",
      projectRow.id,
      projectRow.org_id,
      userId,
    );
    if (grantRole && grantRoleSatisfies(grantRole, mode)) {
      return {
        projectId: projectRow.id,
        orgId: projectRow.org_id,
        ownerUserId: projectRow.owner_user_id,
        visibility: projectRow.visibility,
        role: grantRole as ProjectAccess["role"],
      };
    }

    throw new NotFoundDomainError("project");
  }

  const { data: project, error: projectError } = await context.sb
    .from("projects")
    .select("id, org_id, owner_user_id, visibility")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError) {
    throw new ForbiddenDomainError(`project access resolution failed: ${projectError.message}`);
  }
  if (!project) {
    throw new NotFoundDomainError("project");
  }

  const projectRow = project as {
    id: string;
    org_id: string | null;
    owner_user_id: string;
    visibility: string;
  };

  if (projectRow.owner_user_id === userId) {
    return {
      projectId: projectRow.id,
      orgId: projectRow.org_id,
      ownerUserId: projectRow.owner_user_id,
      visibility: projectRow.visibility,
      role: "owner",
    };
  }

  const { data: membership, error: membershipError } = await context.sb
    .from("project_members")
    .select("role")
    .eq("project_id", projectRow.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) {
    throw new ForbiddenDomainError(`project membership resolution failed: ${membershipError.message}`);
  }

  const projectRole = (membership as { role: string } | null)?.role;
  if (projectRole && projectRoleSatisfies(projectRole, mode)) {
    return {
      projectId: projectRow.id,
      orgId: projectRow.org_id,
      ownerUserId: projectRow.owner_user_id,
      visibility: projectRow.visibility,
      role: projectRole as ProjectAccess["role"],
    };
  }

  if (projectRow.org_id) {
    const { data: orgMembership, error: orgMembershipError } = await context.sb
      .from("org_members")
      .select("role")
      .eq("org_id", projectRow.org_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (orgMembershipError) {
      throw new ForbiddenDomainError(`org membership resolution failed: ${orgMembershipError.message}`);
    }

    const orgRole = (orgMembership as { role: string } | null)?.role;
    if (orgRole && orgRoleSatisfiesProject(orgRole, mode)) {
      return {
        projectId: projectRow.id,
        orgId: projectRow.org_id,
        ownerUserId: projectRow.owner_user_id,
        visibility: projectRow.visibility,
        role: orgRole === "member" ? "org_member" : "org_admin",
      };
    }
  }

  // grants (migration 0038) — the real project_members-equivalent.
  const orFilter = projectRow.org_id
    ? `and(resource_type.eq.project,resource_id.eq.${projectRow.id}),and(resource_type.eq.org,resource_id.eq.${projectRow.org_id})`
    : `and(resource_type.eq.project,resource_id.eq.${projectRow.id})`;
  const { data: grantRows, error: grantError } = await context.sb
    .from("grants")
    .select("role")
    .eq("subject_type", "user")
    .eq("subject_id", userId)
    .or(orFilter);

  if (grantError) {
    throw new ForbiddenDomainError(`grant resolution failed: ${grantError.message}`);
  }

  const grantRole = (grantRows as Array<{ role: string }> | null)?.sort(
    (a, b) => grantRank(b.role) - grantRank(a.role),
  )[0]?.role;
  if (grantRole && grantRoleSatisfies(grantRole, mode)) {
    return {
      projectId: projectRow.id,
      orgId: projectRow.org_id,
      ownerUserId: projectRow.owner_user_id,
      visibility: projectRow.visibility,
      role: grantRole as ProjectAccess["role"],
    };
  }

  throw new NotFoundDomainError("project");
}

export async function requireMemoryWriteAccess(
  context: ActorContext,
  memoryId: string,
): Promise<MemoryAccess> {
  const userId = actorUserId(context);
  const local = getLocalPool();
  if (local) {
    const [memory] = await localQuery<{
      id: string;
      org_id: string | null;
      project_id: string;
      owner_user_id: string;
      visibility: MemoryAccess["visibility"];
    }>(
      "select id, org_id, project_id, owner_user_id, visibility from memories where id = $1 limit 1",
      [memoryId],
    );
    if (!memory) throw new NotFoundDomainError("memory");

    if (memory.owner_user_id === userId) {
      return {
        memoryId: memory.id,
        orgId: memory.org_id,
        projectId: memory.project_id,
        ownerUserId: memory.owner_user_id,
        visibility: memory.visibility,
        via: "owner",
      };
    }

    if (memory.org_id) {
      const [orgMembership] = await localQuery<{ role: string }>(
        "select role from org_members where org_id = $1 and user_id = $2 limit 1",
        [memory.org_id, userId],
      );
      if (["owner", "admin"].includes(orgMembership?.role ?? "")) {
        return {
          memoryId: memory.id,
          orgId: memory.org_id,
          projectId: memory.project_id,
          ownerUserId: memory.owner_user_id,
          visibility: memory.visibility,
          via: "org_admin",
        };
      }
    }

    throw new NotFoundDomainError("memory");
  }

  const { data: row, error } = await context.sb
    .from("memories")
    .select("id, org_id, project_id, owner_user_id, visibility")
    .eq("id", memoryId)
    .maybeSingle();

  if (error) {
    throw new ForbiddenDomainError(`memory access resolution failed: ${error.message}`);
  }
  if (!row) {
    throw new NotFoundDomainError("memory");
  }

  const memory = row as {
    id: string;
    org_id: string | null;
    project_id: string;
    owner_user_id: string;
    visibility: MemoryAccess["visibility"];
  };

  if (memory.owner_user_id === userId) {
    return {
      memoryId: memory.id,
      orgId: memory.org_id,
      projectId: memory.project_id,
      ownerUserId: memory.owner_user_id,
      visibility: memory.visibility,
      via: "owner",
    };
  }

  if (memory.org_id) {
    const { data: orgMembership, error: orgMembershipError } = await context.sb
      .from("org_members")
      .select("role")
      .eq("org_id", memory.org_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (orgMembershipError) {
      throw new ForbiddenDomainError(
        `org membership resolution failed: ${orgMembershipError.message}`,
      );
    }

    const orgRole = (orgMembership as { role: string } | null)?.role;
    if (orgRole === "owner" || orgRole === "admin") {
      return {
        memoryId: memory.id,
        orgId: memory.org_id,
        projectId: memory.project_id,
        ownerUserId: memory.owner_user_id,
        visibility: memory.visibility,
        via: "org_admin",
      };
    }
  }

  const { data: projectMembership, error: projectMembershipError } = await context.sb
    .from("project_members")
    .select("role")
    .eq("project_id", memory.project_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (projectMembershipError) {
    throw new ForbiddenDomainError(
      `project membership resolution failed: ${projectMembershipError.message}`,
    );
  }

  const projectRole = (projectMembership as { role: string } | null)?.role;
  if (projectRole === "admin") {
    return {
      memoryId: memory.id,
      orgId: memory.org_id,
      projectId: memory.project_id,
      ownerUserId: memory.owner_user_id,
      visibility: memory.visibility,
      via: "project_admin",
    };
  }

  throw new NotFoundDomainError("memory");
}

export async function requireMemoryReadAccess(
  context: ActorContext,
  memoryId: string,
): Promise<MemoryAccess> {
  const userId = actorUserId(context);
  const local = getLocalPool();
  if (local) {
    const [memory] = await localQuery<{
      id: string;
      org_id: string | null;
      project_id: string;
      owner_user_id: string;
      visibility: MemoryAccess["visibility"];
    }>(
      "select id, org_id, project_id, owner_user_id, visibility from memories where id = $1 limit 1",
      [memoryId],
    );
    if (!memory) throw new NotFoundDomainError("memory");

    if (memory.visibility === "personal") {
      if (memory.owner_user_id !== userId) throw new NotFoundDomainError("memory");
      return {
        memoryId: memory.id,
        orgId: memory.org_id,
        projectId: memory.project_id,
        ownerUserId: memory.owner_user_id,
        visibility: memory.visibility,
        via: "owner",
      };
    }

    try {
      const access = await requireProjectAccess(context, memory.project_id, "read");
      return {
        memoryId: memory.id,
        orgId: memory.org_id,
        projectId: memory.project_id,
        ownerUserId: memory.owner_user_id,
        visibility: memory.visibility,
        via:
          access.role === "owner"
            ? "owner"
            : access.role && access.role.startsWith("org_")
              ? "org_admin"
              : "project_admin",
      };
    } catch {
      throw new NotFoundDomainError("memory");
    }
  }

  const { data: row, error } = await context.sb
    .from("memories")
    .select("id, org_id, project_id, owner_user_id, visibility")
    .eq("id", memoryId)
    .maybeSingle();

  if (error) {
    throw new ForbiddenDomainError(`memory access resolution failed: ${error.message}`);
  }
  if (!row) {
    throw new NotFoundDomainError("memory");
  }

  const memory = row as {
    id: string;
    org_id: string | null;
    project_id: string;
    owner_user_id: string;
    visibility: MemoryAccess["visibility"];
  };

  if (memory.visibility === "personal") {
    if (memory.owner_user_id !== userId) {
      throw new NotFoundDomainError("memory");
    }

    return {
      memoryId: memory.id,
      orgId: memory.org_id,
      projectId: memory.project_id,
      ownerUserId: memory.owner_user_id,
      visibility: memory.visibility,
      via: "owner",
    };
  }

  try {
    const access = await requireProjectAccess(context, memory.project_id, "read");
    return {
      memoryId: memory.id,
      orgId: memory.org_id,
      projectId: memory.project_id,
      ownerUserId: memory.owner_user_id,
      visibility: memory.visibility,
      via:
        access.role === "owner"
          ? "owner"
          : access.role && access.role.startsWith("org_")
            ? "org_admin"
            : "project_admin",
    };
  } catch {
    throw new NotFoundDomainError("memory");
  }
}
