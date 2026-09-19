import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  ORG_REPOSITORY,
  PROJECT_REPOSITORY,
  type CreateProjectRecord,
  type OrgRepository,
  type ProjectListFilters,
  type ProjectRepository,
} from "@openkt/data-repositories";
import { requireOrgAccess } from "@openkt/auth-authorization";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

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

  listVisible(context: ActorContext, filters: ProjectListFilters) {
    return this.projectRepository.listVisible(context, filters);
  }

  async getById(context: ActorContext, projectId: string) {
    const project = await this.projectRepository.findById(context, projectId);
    if (!project) {
      throw new NotFoundDomainError("project");
    }

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
