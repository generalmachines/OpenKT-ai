import type { ActorContext } from "@openkt/core-context";

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  visibility: "personal" | "org" | "public";
  orgId: string | null;
  ownerUserId: string;
  // The owner's personal space (one per person). Never inferred from the slug.
  isPersonal: boolean;
  // What the space is for, shown to its members.
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRecord {
  slug: string;
  name: string;
  visibility: ProjectRecord["visibility"];
  orgId: string | null;
  description?: string | null;
}

export interface UpdateProjectRecord {
  name?: string;
  description?: string | null;
}

// A member of a space as every member sees it: a name and a role, never an
// email (emails and pending shares stay with the owner's grants list).
export interface ProjectMemberRecord {
  userId: string;
  displayName: string | null;
  role: "owner" | "editor" | "reader";
}

export interface ProjectListFilters {
  orgId?: string;
  visibility?: ProjectRecord["visibility"];
}

export interface ProjectRoleRecord {
  role: "owner" | "admin" | "member" | "viewer" | null;
}

export interface ProjectRepository {
  create(context: ActorContext, input: CreateProjectRecord): Promise<ProjectRecord>;
  listVisible(context: ActorContext, filters: ProjectListFilters): Promise<ProjectRecord[]>;
  findById(context: ActorContext, projectId: string): Promise<ProjectRecord | null>;
  findBySlug(
    context: ActorContext,
    accountSlug: string,
    projectSlug: string,
  ): Promise<ProjectRecord | null>;
  findViewerRole(context: ActorContext, projectId: string): Promise<ProjectRoleRecord["role"]>;
  update(projectId: string, patch: UpdateProjectRecord): Promise<ProjectRecord | null>;
  listMembers(projectId: string): Promise<ProjectMemberRecord[]>;
  softDelete(projectId: string): Promise<void>;
}
