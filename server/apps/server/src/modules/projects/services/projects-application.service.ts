import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  ORG_REPOSITORY,
  PROJECT_REPOSITORY,
  type CreateProjectRecord,
  type OrgRepository,
  type ProjectListFilters,
  type ProjectRecord,
  type ProjectRepository,
  type UpdateProjectRecord,
} from "@openkt/data-repositories";
import { requireOrgAccess, requireProjectAccess } from "@openkt/auth-authorization";
import { ForbiddenDomainError, NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

@Injectable()
export class ProjectsApplicationService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(ORG_REPOSITORY) private readonly orgRepository: OrgRepository,
  ) {}

  async create(context: ActorContext, input: Omit<CreateProjectRecord, "slug"> & { slug?: string }) {
    if (input.visibility === "personal" && input.orgId !== null) {
      throw new ValidationDomainError("personal projects must not include orgId");
    }
    if (input.visibility === "org" && !input.orgId) {
      throw new ValidationDomainError("org projects require orgId");
    }
    if (input.orgId) {
      await requireOrgAccess(context, input.orgId, "write");
    }
    // `personal` names the personal space (ProjectScopeService); a second
    // org-less space with that slug would read as it to every client.
    if (!input.orgId && input.slug === "personal") {
      throw new ValidationDomainError("the slug `personal` is reserved for your personal space");
    }
    const slug = input.slug ?? (await this.freeSlug(context, input.name, input.orgId));
    return this.projectRepository.create(context, { ...input, slug });
  }

  // A slug made from the name, unique among the caller's own org-less spaces
  // (the database only enforces uniqueness inside an org), and never
  // `personal`, which names the personal space.
  private async freeSlug(context: ActorContext, name: string, orgId: string | null): Promise<string> {
    const base = slugFromName(name);
    if (orgId) return base;
    const userId = context.principal.userId;
    const taken = new Set(
      (await this.projectRepository.listVisible(context, {}))
        .filter((p) => p.ownerUserId === userId && p.orgId === null)
        .map((p) => p.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 36)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // PATCH /v1/projects/:id — the owner renames the space or changes its description.
  async update(context: ActorContext, projectId: string, patch: UpdateProjectRecord): Promise<ProjectRecord> {
    await this.requireOwner(context, projectId);
    const updated = await this.projectRepository.update(projectId, patch);
    if (!updated) throw new NotFoundDomainError("project");
    return updated;
  }

  // GET /v1/projects/:id/members — any member: names and roles, no emails.
  async members(context: ActorContext, projectId: string) {
    await requireProjectAccess(context, projectId, "read");
    const members = await this.projectRepository.listMembers(projectId);
    return members.map((m) => ({ user_id: m.userId, display_name: m.displayName, role: m.role }));
  }

  // DELETE /v1/projects/:id — the owner deletes a space (never the personal one).
  async delete(context: ActorContext, projectId: string): Promise<{ id: string; deleted: true }> {
    const project = await this.requireOwner(context, projectId);
    if (project.isPersonal) throw new ValidationDomainError("the personal space cannot be deleted");
    await this.projectRepository.softDelete(projectId);
    return { id: projectId, deleted: true };
  }

  // The literal owner; someone else who can read the space gets 403, anyone
  // else 404 (existence is not leaked).
  private async requireOwner(context: ActorContext, projectId: string): Promise<ProjectRecord> {
    const project = await this.projectRepository.findById(context, projectId);
    if (!project) throw new NotFoundDomainError("project");
    if (project.ownerUserId === context.principal.userId) return project;
    await requireProjectAccess(context, projectId, "read");
    throw new ForbiddenDomainError("only the space's owner can do this");
  }

  listVisible(context: ActorContext, filters: ProjectListFilters) {
    return this.projectRepository.listVisible(context, filters);
  }

  async getById(context: ActorContext, projectId: string) {
    const project = await this.projectRepository.findById(context, projectId);
    if (!project) {
      throw new NotFoundDomainError("project");
    }
    // Only someone who can read the space learns it exists (Spec 04: 404).
    await requireProjectAccess(context, projectId, "read");

    const viewerRole = await this.projectRepository.findViewerRole(context, projectId);
    return {
      ...project,
      viewerRole,
    };
  }

  async getBySlug(
    context: ActorContext,
    accountSlug: string,
    projectSlug: string,
  ) {
    const project = await this.projectRepository.findBySlug(context, accountSlug, projectSlug);
    if (!project) {
      throw new NotFoundDomainError("project");
    }

    const viewerRole = await this.projectRepository.findViewerRole(context, project.id);
    const orgId = project.orgId
      ? await this.orgRepository.findIdBySlug(context, accountSlug)
      : null;

    return {
      ...project,
      viewerRole,
      accountSlug,
      orgId,
    };
  }
}

// "Hackathon Crew!" → "hackathon-crew". Always matches the slug rule
// (^[a-z0-9][a-z0-9-]{1,40}$) and is never "personal".
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  if (slug.length < 2) return "team";
  return slug === "personal" ? "personal-team" : slug;
}
