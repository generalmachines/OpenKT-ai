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
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRecord {
  slug: string;
  name: string;
  visibility: ProjectRecord["visibility"];
  orgId: string | null;
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
}
